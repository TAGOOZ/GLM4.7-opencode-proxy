import crypto from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { GLMClient } from "../glmClient.js";
import { extractFirstJsonObject, repairPlannerJson } from "web-wrapper-protocol";
import {
  ACTIONABLE_KEYWORDS,
  DEFAULT_MODEL,
  DANGEROUS_COMMAND_PATTERNS,
  EMBEDDED_READ_REGEX,
  FILE_MENTION_REGEX,
  PLANNER_JSON_HINT_REGEX,
  PROXY_ALLOW_WEB_SEARCH,
  PROXY_ALWAYS_SEND_SYSTEM,
  PROXY_COMPACT_RESET,
  PROXY_DEBUG,
  PROXY_DEFAULT_THINKING,
  PROXY_INCLUDE_USAGE,
  PROXY_PLANNER_COERCE,
  PROXY_PLANNER_MAX_RETRIES,
  PROXY_MAX_ACTIONS_PER_TURN,
  PROXY_TEST_MODE,
  PROXY_TOOL_LOOP_LIMIT,
  PROXY_USE_GLM_HISTORY,
  PROXY_HISTORY_MAX_MESSAGES,
  PROXY_ALLOW_USER_HEURISTICS,
  READ_LIKE_WITH_FILE_REGEX,
  REPO_STRUCTURE_PATTERNS,
} from "./constants.js";
import {
  compactMessages,
  estimateMessagesTokens,
  estimateTokens,
  getContextConfig,
  type ContextStats,
} from "./context.js";
import { collectGlmResponse, convertMessages, stripDirectivesFromContent } from "./messages.js";
import { openaiContentResponse, openaiToolResponse, sendToolCalls, streamContent } from "./openai.js";
import {
  inferExplicitToolCalls,
  inferListToolCall,
  inferReadToolCall,
  inferSearchToolCall,
} from "./tools/infer.js";
import { buildToolRegistry, findTool, normalizeArgsForTool, type ToolInfo } from "./tools/registry.js";
import { parseRawToolCalls, tryParseModelOutput, tryRepairPlannerOutput } from "./tools/parse.js";
import { inferRecentFilePath } from "./tools/path.js";

type ChatCompletionHandlerDeps = {
  client: GLMClient;
  ensureChat: () => Promise<string>;
  resetChat: () => void;
};

const createChatCompletionHandler = ({ client, ensureChat, resetChat }: ChatCompletionHandlerDeps) => {
  const contextConfig = getContextConfig();
  const useGlmHistory = PROXY_USE_GLM_HISTORY;
  const alwaysSendSystem = PROXY_ALWAYS_SEND_SYSTEM;
  let lastMessages: any[] = [];
  let lastSignature = "";

  const extractTestDirectives = (content: string) => {
    const lines = content.split(/\r?\n/);
    const kept: string[] = [];
    let systemLine: string | null = null;
    let forceToolResult = false;
    let disableHeuristics = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("/system")) {
        const value = trimmed.slice("/system".length).trim();
        if (value) systemLine = value;
        continue;
      }
      if (
        trimmed === "/test tool_result" ||
        trimmed === "/test tool-result" ||
        trimmed === "/test tool_loop" ||
        trimmed === "/test tool-loop"
      ) {
        forceToolResult = true;
        continue;
      }
      if (
        trimmed === "/test no-heuristics" ||
        trimmed === "/test no_heuristics" ||
        trimmed === "/test disable-heuristics" ||
        trimmed === "/test disable_heuristics"
      ) {
        disableHeuristics = true;
        continue;
      }
      kept.push(line);
    }
    return { cleaned: kept.join("\n").trim(), systemLine, forceToolResult, disableHeuristics };
  };

  const buildMessages = (sourceMessages: any[], toolList: any[]) => {
    const converted = convertMessages(sourceMessages, toolList, {
      toolMaxLines: contextConfig.toolMaxLines,
      toolMaxChars: contextConfig.toolMaxChars,
    });
    return compactMessages(converted, contextConfig);
  };

  const buildInstructionMessages = (systemContent: string, sourceMessages: any[], toolList: any[]) => {
    const base = buildMessages(sourceMessages, toolList);
    const combined = compactMessages(
      [
        {
          role: "system",
          content: systemContent,
        },
        ...base.messages,
      ],
      contextConfig,
    );
    return combined;
  };

  const buildUsage = (promptTokens: number, completionText: string) => {
    if (!PROXY_INCLUDE_USAGE) return undefined;
    const completionTokens = estimateTokens(completionText);
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  };

  const buildToolUsage = (promptTokens: number, toolCalls: any[]) => {
    if (!PROXY_INCLUDE_USAGE) return undefined;
    const completionTokens = estimateTokens(JSON.stringify(toolCalls));
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  };

  const buildStreamHeaders = (stats?: ContextStats): Record<string, string> => {
    if (!PROXY_INCLUDE_USAGE || !stats) return {};
    return {
      "x-context-used": String(stats.usedTokens),
      "x-context-remaining": String(stats.remainingTokens),
      "x-context-budget": String(stats.budgetTokens),
    };
  };

  const applyResponseHeaders = (reply: FastifyReply, stats?: ContextStats) => {
    if (!PROXY_INCLUDE_USAGE || !stats) return;
    reply.header("x-context-used", String(stats.usedTokens));
    reply.header("x-context-remaining", String(stats.remainingTokens));
    reply.header("x-context-budget", String(stats.budgetTokens));
  };

  const extractContentText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (!part) return "";
          if (typeof part === "string") return part;
          if (typeof part === "object") {
            const text = (part as { text?: unknown }).text;
            if (typeof text === "string") return text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (content && typeof content === "object") {
      const text = (content as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
    return "";
  };

  const buildSignature = (tools: any[], systemText: string) => {
    return JSON.stringify({
      tools,
      system: systemText,
    });
  };

  const normalizeDeltaContent = (content: string): string => {
    return content.trim();
  };

  const messageDeltaKey = (msg: any) => {
    const role = msg?.role;
    const toolCalls = Array.isArray(msg?.tool_calls)
      ? msg.tool_calls.map((call: any) => ({
          type: call?.type,
          function: call?.function
            ? {
                name: call.function.name,
                arguments: call.function.arguments,
              }
            : undefined,
        }))
      : undefined;
    const toolCallId = role === "tool" ? msg?.tool_call_id : undefined;
    const rawContent = extractContentText(msg?.content);
    const content = rawContent ? normalizeDeltaContent(rawContent) : rawContent;
    return JSON.stringify({
      role,
      tool_call_id: toolCallId,
      tool_calls: toolCalls,
      content,
    });
  };

  const computeDeltaMessages = (current: any[]) => {
    const currentKeys = current.map(messageDeltaKey);
    const lastKeys = lastMessages.map(messageDeltaKey);
    let idx = 0;
    while (idx < currentKeys.length && idx < lastKeys.length && currentKeys[idx] === lastKeys[idx]) {
      idx += 1;
    }
    const mismatch = idx < lastKeys.length && idx < currentKeys.length;
    const truncated = currentKeys.length < lastKeys.length;
    if (mismatch || truncated) {
      if (PROXY_DEBUG) {
        console.log(
          "proxy_debug delta_mismatch:",
          JSON.stringify({
            index: idx,
            last: lastKeys[idx]?.slice(0, 200),
            current: currentKeys[idx]?.slice(0, 200),
            lastLen: lastKeys.length,
            currentLen: currentKeys.length,
            truncated,
          }),
        );
      }
      return { delta: current, reseed: true, reset: true };
    }
    return { delta: current.slice(idx), reseed: idx === 0, reset: false };
  };

  const sendStreamContent = (
    reply: FastifyReply,
    content: string,
    model: string,
    stats?: ContextStats,
    promptTokens?: number,
  ) => {
    const headers = buildStreamHeaders(stats);
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", ...headers });
    const usage =
      promptTokens !== undefined ? buildUsage(promptTokens, content) : undefined;
    reply.raw.write(streamContent(content, model, usage));
    return reply.raw.end();
  };

  const sendContent = (
    reply: FastifyReply,
    content: string,
    model: string,
    promptTokens: number,
    stats?: ContextStats,
  ) => {
    applyResponseHeaders(reply, stats);
    return reply.send(openaiContentResponse(content, model, buildUsage(promptTokens, content)));
  };

  const isUnsafePathInput = (input: string): boolean => {
    const trimmed = input.trim();
    if (!trimmed) return true;
    if (trimmed.includes("\0")) return true;
    if (trimmed.startsWith("~")) return true;
    if (/(^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed)) return true;
    return false;
  };

  const isSensitivePath = (value: string): boolean => {
    const normalized = value.replace(/\\/g, "/").toLowerCase();
    const patterns = [
      /(^|\/)\.ssh(\/|$)/,
      /(^|\/)\.git(\/|$)/,
      /(^|\/)\.env(\.|$|\/)/,
      /(^|\/)\.npmrc($|\/)/,
      /(^|\/)\.pypirc($|\/)/,
      /(^|\/)\.netrc($|\/)/,
      /(^|\/)id_rsa($|\/)/,
      /(^|\/)id_ed25519($|\/)/,
      /(^|\/)creds?[^\/]*$/i,
      /(^|\/)credentials?[^\/]*$/i,
      /(^|\/)[^\/]*key[^\/]*$/i,
    ];
    return patterns.some((pattern) => pattern.test(normalized));
  };

  const MAX_WRITE_CHARS = 200000;

  const isSafeGlobPattern = (pattern: string): boolean => {
    const trimmed = pattern.trim();
    if (!trimmed) return true;
    const raw = trimmed.startsWith("!") ? trimmed.slice(1) : trimmed;
    if (!raw) return true;
    const normalized = raw.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.startsWith("~")) return false;
    if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//")) return false;
    if (/(^|\/)\.\.(\/|$)/.test(normalized)) return false;
    if (/\{[^}]*\.\.[^}]*\}/.test(normalized)) return false;
    return true;
  };

  const MUTATION_TOOLS = new Set([
    "write",
    "write_file",
    "apply_patch",
    "patch",
    "edit",
    "run",
    "run_shell",
    "bash",
    "shell",
    "delete",
    "remove",
    "mkdir",
    "move",
    "mv",
  ]);

  const RAW_TOOL_ALLOWLIST = new Set([
    "read",
    "read_file",
    "list",
    "list_dir",
    "glob",
    "grep",
    "search",
    "rg",
    "ripgrep",
  ]);

  const normalizeToolName = (value: unknown) =>
    String(value || "").toLowerCase().replace(/[_-]/g, "");

  const MUTATION_TOOLS_NORM = new Set([...MUTATION_TOOLS].map((t) => normalizeToolName(t)));
  const RAW_TOOL_ALLOWLIST_NORM = new Set([...RAW_TOOL_ALLOWLIST].map((t) => normalizeToolName(t)));

  const isRawToolCallsAllowed = (calls: any[]): boolean => {
    return calls.every((call) => {
      const toolName = normalizeToolName(call?.function?.name || call?.name || "");
      return RAW_TOOL_ALLOWLIST_NORM.has(toolName);
    });
  };

  const extractPlannerFinal = (text: string): string | null => {
    if (!text || !text.trim()) return null;
    const parsed = tryParseModelOutput(text, true);
    if (parsed.ok && parsed.data && parsed.data.actions.length === 0) {
      return parsed.data.final || "";
    }
    const repaired = tryRepairPlannerOutput(text);
    if (repaired && repaired.actions.length === 0) {
      return repaired.final || "";
    }
    return null;
  };

  type GuardResult =
    | { ok: true }
    | { ok: false; reason: string };

  const validateToolCalls = (
    toolCalls: any[],
    source: "planner" | "raw" | "heuristic" | "explicit",
    registry: Map<string, ToolInfo>
  ): GuardResult => {
    for (const call of toolCalls) {
      const toolName = normalizeToolName(call?.function?.name || call?.name || "");
      const toolInfo = findTool(registry, toolName);
      let args: Record<string, unknown> = {};
      const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
      if (typeof rawArgs === "string") {
        try {
          args = JSON.parse(rawArgs);
        } catch {
          return { ok: false, reason: "invalid_tool_args" };
        }
      } else if (rawArgs && typeof rawArgs === "object") {
        args = rawArgs as Record<string, unknown>;
      }

      if (toolInfo?.argKeys?.length) {
        const allowed = new Set(toolInfo.argKeys.map((k) => k.toLowerCase()));
        for (const key of Object.keys(args)) {
          if (!allowed.has(key.toLowerCase())) {
            return { ok: false, reason: "unexpected_arg" };
          }
        }
      }

      if (source !== "planner" && MUTATION_TOOLS_NORM.has(toolName)) {
        return { ok: false, reason: "mutation_requires_planner_json" };
      }

      if (toolName === "glob") {
        const pattern = String(args.pattern ?? "");
        if (!isSafeGlobPattern(pattern)) return { ok: false, reason: "path_outside_workspace" };
        continue;
      }

      if (
        toolName === "read" ||
        toolName === "readfile" ||
        toolName === "write" ||
        toolName === "writefile" ||
        toolName === "list" ||
        toolName === "listdir"
      ) {
        const pathValue = String(
          args.path ??
          args.filePath ??
          args.file_path ??
          args.dir ??
          ""
        ).trim();
        if (!pathValue) {
          return { ok: false, reason: "missing_path" };
        }
        if (isUnsafePathInput(pathValue)) {
          return { ok: false, reason: "path_outside_workspace" };
        }
        if (isSensitivePath(pathValue)) {
          return { ok: false, reason: "sensitive_path" };
        }
        if ((toolName === "write" || toolName === "writefile") && args.content != null) {
          const content = String(args.content);
          if (content.length > MAX_WRITE_CHARS) {
            return { ok: false, reason: "content_too_large" };
          }
        }
        continue;
      }

      if (toolName === "edit" || toolName === "editfile" || toolName === "applypatch" || toolName === "patch") {
        const pathValue = String(
          args.path ??
          args.filePath ??
          args.file_path ??
          ""
        ).trim();
        if (pathValue) {
          if (isUnsafePathInput(pathValue)) return { ok: false, reason: "path_outside_workspace" };
          if (isSensitivePath(pathValue)) return { ok: false, reason: "sensitive_path" };
        }
      }

      if (toolName === "run" || toolName === "runshell" || toolName === "bash" || toolName === "shell") {
        const command = String(args.command ?? args.cmd ?? "").trim();
        if (!command) return { ok: false, reason: "missing_command" };
        if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
          return { ok: false, reason: "command_blocked" };
        }
        if (source !== "planner") {
          if (!/^(rg|ripgrep|grep)\b/i.test(command.trim())) {
            return { ok: false, reason: "mutation_requires_planner_json" };
          }
        }
      }
    }
    return { ok: true };
  };

  const guardAndSendToolCalls = (
    reply: FastifyReply,
    toolCalls: any[],
    model: string,
    stream: boolean,
    headers: Record<string, string>,
    usage: Record<string, number> | undefined,
    promptTokens: number,
    stats?: ContextStats,
    source: "planner" | "raw" | "heuristic" | "explicit" = "planner",
    registry?: Map<string, ToolInfo>,
  ) => {
    if (!registry) {
      const content = "Tool registry missing; cannot validate tool calls.";
      if (stream) {
        return sendStreamContent(reply, content, model, stats, promptTokens);
      }
      return sendContent(reply, content, model, promptTokens, stats);
    }
    const guard = validateToolCalls(toolCalls, source, registry);
    if (!guard.ok) {
      const content = `Blocked unsafe tool call (${guard.reason}).`;
      if (stream) {
        return sendStreamContent(reply, content, model, stats, promptTokens);
      }
      return sendContent(reply, content, model, promptTokens, stats);
    }
    applyResponseHeaders(reply, stats);
    return sendToolCalls(reply, toolCalls, model, stream, headers, usage);
  };

  const validatePlannerActions = (
    actions: { tool: string; args: Record<string, unknown> }[]
  ): { ok: boolean; reason?: string } => {
    if (actions.length > PROXY_MAX_ACTIONS_PER_TURN) {
      return { ok: false, reason: "too_many_actions" };
    }
    const seen = new Set<string>();
    for (const action of actions) {
      const key = `${action.tool}|${JSON.stringify(action.args ?? {})}`;
      if (seen.has(key)) {
        return { ok: false, reason: "duplicate_actions" };
      }
      seen.add(key);
    }
    return { ok: true };
  };

  const detectUnknownToolFromUserJson = (
    userText: string,
    registry: Map<string, ToolInfo>,
  ): string | null => {
    if (!userText || userText.indexOf("{") === -1) return null;
    const extracted = extractFirstJsonObject(userText);
    if (!extracted.json) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(repairPlannerJson(extracted.json));
    } catch {
      return null;
    }
    const rawActions = Array.isArray(parsed?.actions)
      ? parsed.actions
      : parsed?.actions
        ? [parsed.actions]
        : [];
    for (const action of rawActions) {
      const name = typeof action?.tool === "string" ? action.tool : "";
      if (!name) continue;
      if (!findTool(registry, name)) return name;
    }
    return null;
  };

  const handleChatCompletion = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const model = body.model || DEFAULT_MODEL;
    const messages = body.messages || [];
    const rawTools = body.tools || [];
    const stream = Boolean(body.stream);
    const toolChoice = body.tool_choice;
    let chatId: string | null = null;
    const getChatId = async () => {
      if (!chatId) {
        chatId = await ensureChat();
      }
      return chatId;
    };

    const tools = rawTools;

    if (toolChoice === "none") {
      tools.length = 0;
    }

    const lastUserIndex = (() => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === "user") return i;
      }
      return -1;
    })();
    const lastUserContent = lastUserIndex >= 0 ? messages[lastUserIndex].content : "";
    const directiveResult = stripDirectivesFromContent(lastUserContent);
    const directiveContent = extractContentText(directiveResult.content);
    const testDirectives = PROXY_TEST_MODE
      ? extractTestDirectives(directiveContent)
      : { cleaned: directiveContent, systemLine: null, forceToolResult: false, disableHeuristics: false };
    const lastUser: string = testDirectives.cleaned || "";
    const sanitizedContent: string = testDirectives.cleaned || "";
    let sanitizedMessages =
      lastUserIndex >= 0 && sanitizedContent !== lastUserContent
        ? messages.map((msg: any, idx: number) =>
            idx === lastUserIndex ? { ...msg, content: sanitizedContent } : msg
          )
        : messages;
    if (PROXY_TEST_MODE && testDirectives.systemLine) {
      sanitizedMessages = [{ role: "system", content: testDirectives.systemLine }, ...sanitizedMessages];
    }
    if (PROXY_TEST_MODE && testDirectives.forceToolResult) {
      sanitizedMessages = [
        ...sanitizedMessages,
        { role: "tool", name: "test_tool", content: "synthetic tool result" },
      ];
    }
    const last = sanitizedMessages[sanitizedMessages.length - 1];
    let hasToolResult = Boolean(last && (last.role === "tool" || last.tool_call_id));
    let toolResultCount = sanitizedMessages.filter((m: any) => m.role === "tool" || m.tool_call_id).length;
    const maxToolLoops = PROXY_TOOL_LOOP_LIMIT;
    if (PROXY_TEST_MODE && testDirectives.forceToolResult) {
      hasToolResult = true;
      toolResultCount = Math.max(toolResultCount, maxToolLoops);
    }
    const toolRegistry = buildToolRegistry(tools);
    const bodyFeatures = body?.features && typeof body.features === "object" ? body.features : {};
    const featureOverrides: Record<string, unknown> = { ...bodyFeatures };
    const allowWebSearch = PROXY_ALLOW_WEB_SEARCH;
    const enableThinking =
      typeof body?.enable_thinking === "boolean"
        ? body.enable_thinking
        : typeof body?.enableThinking === "boolean"
          ? body.enableThinking
          : typeof (bodyFeatures as { enable_thinking?: unknown }).enable_thinking === "boolean"
            ? (bodyFeatures as { enable_thinking: boolean }).enable_thinking
            : typeof (bodyFeatures as { enableThinking?: unknown }).enableThinking === "boolean"
              ? (bodyFeatures as { enableThinking: boolean }).enableThinking
              : PROXY_DEFAULT_THINKING;
    if (typeof directiveResult.overrides.enable_thinking === "boolean") {
      featureOverrides.enable_thinking = directiveResult.overrides.enable_thinking;
    }
    if (typeof directiveResult.overrides.web_search === "boolean") {
      featureOverrides.web_search = directiveResult.overrides.web_search;
      if (featureOverrides.web_search === true && featureOverrides.auto_web_search === undefined) {
        featureOverrides.auto_web_search = true;
      }
    }
    if (typeof directiveResult.overrides.auto_web_search === "boolean") {
      featureOverrides.auto_web_search = directiveResult.overrides.auto_web_search;
    }
    const enableThinkingFinal =
      typeof featureOverrides.enable_thinking === "boolean"
        ? (featureOverrides.enable_thinking as boolean)
        : enableThinking;
    if (typeof body?.web_search === "boolean") {
      featureOverrides.web_search = body.web_search;
      if (featureOverrides.web_search === true && featureOverrides.auto_web_search === undefined) {
        featureOverrides.auto_web_search = true;
      }
    }
    if (typeof body?.auto_web_search === "boolean") {
      featureOverrides.auto_web_search = body.auto_web_search;
    }
    if (!allowWebSearch) {
      featureOverrides.web_search = false;
      featureOverrides.auto_web_search = false;
    } else if (featureOverrides.web_search === true && featureOverrides.auto_web_search === undefined) {
      featureOverrides.auto_web_search = true;
    }
    const loweredUser = lastUser.toLowerCase();
    const hasEmbeddedRead = EMBEDDED_READ_REGEX.test(lastUser);
    const disableHeuristics = PROXY_TEST_MODE && testDirectives.disableHeuristics;
    const fileMention = FILE_MENTION_REGEX.test(lastUser);
    const repoStructureIntent = REPO_STRUCTURE_PATTERNS.some((pattern) => pattern.test(loweredUser));
    const readLikeWithFile = READ_LIKE_WITH_FILE_REGEX.test(loweredUser);
    let actionable =
      ACTIONABLE_KEYWORDS.some((k) => loweredUser.includes(k)) ||
      repoStructureIntent ||
      (fileMention && readLikeWithFile);
    if (hasEmbeddedRead) {
      actionable = false;
    }
    if (PROXY_DEBUG) {
      const roles = messages.map((m: any) => m.role).join(",");
      const sys = messages.find((m: any) => m.role === "system")?.content || "";
      console.log("proxy_debug stream:", stream, "tool_choice:", toolChoice);
      console.log("proxy_debug roles:", roles);
      if (sys) {
        console.log("proxy_debug system:", sys.slice(0, 200));
      }
      if (hasToolResult) {
        const toolMsg = messages.slice().reverse().find((m: any) => m.role === "tool");
        const toolPreview = toolMsg?.content
          ? toolMsg.content.slice(0, 200)
          : "";
        console.log("proxy_debug tool_result_preview:", toolPreview);
      }
    }
    const toolChoiceRequired =
      toolChoice === "required" ||
      (toolChoice && typeof toolChoice === "object" && toolChoice.type === "function");

    const allowHeuristicTools = PROXY_ALLOW_USER_HEURISTICS && !hasEmbeddedRead && !disableHeuristics;
    const explicitToolCalls =
      !hasToolResult && tools.length > 0
        ? inferExplicitToolCalls(toolRegistry, lastUser)
        : null;
    const inferredToolCall =
      allowHeuristicTools && !hasToolResult && tools.length > 0
        ? inferReadToolCall(toolRegistry, lastUser) ||
          inferListToolCall(toolRegistry, lastUser) ||
          inferSearchToolCall(toolRegistry, lastUser)
        : null;

    const shouldAttemptTools = tools.length > 0;
    const systemText = sanitizedMessages
      .filter((msg: any) => msg.role === "system")
      .map((msg: any) => extractContentText(msg.content))
      .filter(Boolean)
      .join("\n\n");
    const baseMessages = buildMessages(sanitizedMessages, shouldAttemptTools ? tools : []);
    let glmMessages = baseMessages.messages;
    let glmStats = baseMessages.stats;
    if (PROXY_DEBUG) {
      console.log("proxy_debug compaction_stats:", JSON.stringify(baseMessages.stats));
    }
    const compactionReset =
      PROXY_COMPACT_RESET &&
      (baseMessages.stats.summaryAdded || baseMessages.stats.droppedMessages > 0);
    if (compactionReset) {
      resetChat();
      chatId = null;
      if (useGlmHistory) {
        lastMessages = [];
        lastSignature = "";
      }
      if (PROXY_DEBUG) {
        console.log("proxy_debug compaction_reset: true");
      }
    }
    const useHistoryThisRequest = useGlmHistory && !compactionReset;
    if (useHistoryThisRequest) {
      const signature = buildSignature(shouldAttemptTools ? tools : [], systemText);
      const signatureChanged = signature !== lastSignature;
      const deltaResult = computeDeltaMessages(sanitizedMessages);
      if (deltaResult.reset || signatureChanged) {
        resetChat();
        chatId = null;
        lastMessages = [];
      }
      const reseed = deltaResult.reseed || signatureChanged || lastMessages.length === 0;
      const deltaMessages = deltaResult.reset || signatureChanged ? sanitizedMessages : deltaResult.delta;
      const shouldInjectSystem = alwaysSendSystem && systemText && tools.length === 0;
      if (PROXY_DEBUG) {
        console.log(
          "proxy_debug history_delta:",
          JSON.stringify({
            reset: deltaResult.reset || signatureChanged,
            reseed,
            deltaCount: deltaMessages.length,
            signatureChanged,
          }),
        );
        if (shouldInjectSystem) {
          console.log("proxy_debug system_injected: true");
        }
      }
      const injectedDeltaMessages =
        shouldInjectSystem && !deltaMessages.some((msg: any) => msg.role === "system")
          ? [{ role: "system", content: systemText }, ...deltaMessages]
          : deltaMessages;
      const toolSeed = alwaysSendSystem ? tools : reseed ? tools : [];
      const extraSystem = alwaysSendSystem ? systemText : reseed ? systemText : "";
      const deltaConverted = convertMessages(injectedDeltaMessages, toolSeed, {
        toolMaxLines: contextConfig.toolMaxLines,
        toolMaxChars: contextConfig.toolMaxChars,
        extraSystem,
      });
      const compacted = compactMessages(deltaConverted, contextConfig);
      glmMessages = compacted.messages;
      glmStats = baseMessages.stats;
      lastMessages =
        PROXY_HISTORY_MAX_MESSAGES > 0
          ? sanitizedMessages.slice(-PROXY_HISTORY_MAX_MESSAGES)
          : sanitizedMessages;
      lastSignature = signature;
    } else if (useGlmHistory) {
      lastMessages =
        PROXY_HISTORY_MAX_MESSAGES > 0
          ? sanitizedMessages.slice(-PROXY_HISTORY_MAX_MESSAGES)
          : sanitizedMessages;
      lastSignature = buildSignature(shouldAttemptTools ? tools : [], systemText);
    }
    const POST_TOOL_SYSTEM = [
      "You have received tool results.",
      "Continue the task.",
      "If more tools are needed, return ONLY a JSON object matching the schema with actions.",
      "If no further tools are needed, return ONLY a JSON object matching the schema with actions empty and include final.",
      "No extra text or analysis.",
    ].join(" ");

    if (hasToolResult && shouldAttemptTools) {
      const instructed = buildInstructionMessages(
        POST_TOOL_SYSTEM,
        sanitizedMessages,
        shouldAttemptTools ? tools : [],
      );
      if (useHistoryThisRequest) {
        const toolSeed = tools;
        const instructedMessages = convertMessages(sanitizedMessages, toolSeed, {
          toolMaxLines: contextConfig.toolMaxLines,
          toolMaxChars: contextConfig.toolMaxChars,
          extraSystem: systemText,
        });
        const withInstruction = compactMessages(
          [
            {
              role: "system",
              content:
                POST_TOOL_SYSTEM,
            },
            ...instructedMessages,
          ],
          contextConfig,
        );
        glmMessages = withInstruction.messages;
        glmStats = instructed.stats;
      } else {
        glmMessages = instructed.messages;
        glmStats = instructed.stats;
      }
    }
    let responsePromptTokens = estimateMessagesTokens(glmMessages);
    const streamHeaders = buildStreamHeaders(glmStats);

    if (shouldAttemptTools) {
      // If the user provides explicit planner JSON that references unknown tools, fail fast
      // instead of relying on the model to echo invalid JSON.
      const unknown = detectUnknownToolFromUserJson(lastUser, toolRegistry);
      if (unknown) {
        const content = `Unknown tool: ${unknown}`;
        if (stream) {
          return sendStreamContent(reply, content, model, glmStats, responsePromptTokens);
        }
        return sendContent(reply, content, model, responsePromptTokens, glmStats);
      }

      const earlyFallback = explicitToolCalls || inferredToolCall;
      const earlySource: "planner" | "raw" | "heuristic" | "explicit" =
        explicitToolCalls ? "explicit" : inferredToolCall ? "heuristic" : "planner";
      if (PROXY_DEBUG) {
        console.log("proxy_debug tools:", tools.map((t: any) => t.function?.name || t.name || "tool"));
        console.log("proxy_debug lastUser:", lastUser);
        console.log("proxy_debug earlyFallback:", Boolean(earlyFallback));
      }
      if (earlyFallback) {
        return guardAndSendToolCalls(
          reply,
          earlyFallback,
          model,
          stream,
          streamHeaders,
          buildToolUsage(responsePromptTokens, earlyFallback),
          responsePromptTokens,
          glmStats,
          earlySource,
          toolRegistry,
        );
      }

      const activeChatId = await getChatId();
      let responseText = await collectGlmResponse(client, activeChatId, glmMessages, {
        enableThinking: enableThinkingFinal,
        features: featureOverrides,
        includeThinking: false,
        includeHistory: useHistoryThisRequest,
      });
      const initialResponseText = responseText;
      if (PROXY_DEBUG) {
        const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
        console.log("proxy_debug model_raw:", preview);
      }
      const earlyRawToolCalls = parseRawToolCalls(responseText, toolRegistry);
      if (earlyRawToolCalls && isRawToolCallsAllowed(earlyRawToolCalls)) {
        return guardAndSendToolCalls(
          reply,
          earlyRawToolCalls,
          model,
          stream,
          streamHeaders,
          buildToolUsage(responsePromptTokens, earlyRawToolCalls),
          responsePromptTokens,
          glmStats,
          "raw",
          toolRegistry,
        );
      } else if (earlyRawToolCalls && PROXY_DEBUG) {
        console.log("proxy_debug raw_tool_calls_blocked: true");
      }
      let parsed = tryParseModelOutput(responseText, false);
      if (PROXY_DEBUG && !parsed.ok) {
        console.log("proxy_debug json_parse_error:", parsed.error);
      }
      if (!parsed.ok && PROXY_PLANNER_MAX_RETRIES > 0) {
        // one retry with corrective message
        const corrective = {
          role: "assistant",
          content: "Return ONLY valid JSON following the schema. No extra text or analysis.",
        };
        const correctedMessages = [...glmMessages, corrective];
        responseText = await collectGlmResponse(client, activeChatId, correctedMessages, {
          enableThinking: enableThinkingFinal,
          features: featureOverrides,
          includeThinking: false,
          includeHistory: useHistoryThisRequest,
        });
        responsePromptTokens = estimateMessagesTokens(correctedMessages);
        if (PROXY_DEBUG) {
          const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
          console.log("proxy_debug model_retry_raw:", preview);
        }
        parsed = tryParseModelOutput(responseText, false);
        if (PROXY_DEBUG && !parsed.ok) {
          console.log("proxy_debug json_parse_error:", parsed.error);
        }
      }

      if (!parsed.ok && PROXY_PLANNER_MAX_RETRIES > 1) {
        const stricter = {
          role: "assistant",
          content: "Return ONLY valid JSON object. No markdown, no analysis, no extra keys.",
        };
        const stricterMessages = [...glmMessages, stricter];
        responseText = await collectGlmResponse(client, activeChatId, stricterMessages, {
          enableThinking: enableThinkingFinal,
          features: featureOverrides,
          includeThinking: false,
          includeHistory: useHistoryThisRequest,
        });
        responsePromptTokens = estimateMessagesTokens(stricterMessages);
        if (PROXY_DEBUG) {
          const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
          console.log("proxy_debug model_retry2_raw:", preview);
        }
        parsed = tryParseModelOutput(responseText, false);
        if (PROXY_DEBUG && !parsed.ok) {
          console.log("proxy_debug json_parse_error:", parsed.error);
        }
      }

      if (!parsed.ok) {
        parsed = tryParseModelOutput(responseText, true);
        if (!parsed.ok && responseText !== initialResponseText) {
          parsed = tryParseModelOutput(initialResponseText, true);
        }
      }

      if (!parsed.ok || !parsed.data) {
        const repaired = tryRepairPlannerOutput(responseText);
        if (repaired) {
          parsed = { ok: true, data: repaired };
        }
      }

      const maybeRawToolCalls =
        (!parsed.ok || !parsed.data || (parsed.data.actions.length === 0 && responseText.trim().startsWith("[")))
          ? parseRawToolCalls(responseText, toolRegistry)
          : null;
      if (maybeRawToolCalls) {
        if (isRawToolCallsAllowed(maybeRawToolCalls)) {
          return guardAndSendToolCalls(
            reply,
            maybeRawToolCalls,
            model,
            stream,
            streamHeaders,
            buildToolUsage(responsePromptTokens, maybeRawToolCalls),
            responsePromptTokens,
            glmStats,
            "raw",
            toolRegistry,
          );
        }
        if (PROXY_DEBUG) {
          console.log("proxy_debug raw_tool_calls_blocked: true");
        }
      }

      if (!parsed.ok || !parsed.data) {
        if (PROXY_PLANNER_COERCE && !toolChoiceRequired) {
          parsed = {
            ok: true,
            data: {
              plan: ["answer directly"],
              actions: [],
              final: responseText.trim(),
            },
          };
        }
      }

      if (!parsed.ok || !parsed.data) {
        const rawToolCalls = parseRawToolCalls(responseText, toolRegistry);
        if (rawToolCalls) {
          if (isRawToolCallsAllowed(rawToolCalls)) {
            return guardAndSendToolCalls(
              reply,
              rawToolCalls,
              model,
              stream,
              streamHeaders,
              buildToolUsage(responsePromptTokens, rawToolCalls),
              responsePromptTokens,
              glmStats,
              "raw",
              toolRegistry,
            );
          }
          if (PROXY_DEBUG) {
            console.log("proxy_debug raw_tool_calls_blocked: true");
          }
        }
      if (hasToolResult) {
        const looksLikePlannerJson = PLANNER_JSON_HINT_REGEX.test(responseText) || responseText.trim().startsWith("{");
        if (looksLikePlannerJson) {
            const finalPayload = buildInstructionMessages(POST_TOOL_SYSTEM, messages, tools);
            const finalText = await collectGlmResponse(client, activeChatId, finalPayload.messages, {
              enableThinking: enableThinkingFinal,
              features: featureOverrides,
              includeThinking: false,
              includeHistory: useHistoryThisRequest,
            });
            const finalPromptTokens = estimateMessagesTokens(finalPayload.messages);
            const extractedFinal = extractPlannerFinal(finalText) ?? extractPlannerFinal(responseText);
            const finalContent = extractedFinal ?? finalText;
            if (stream) {
              return sendStreamContent(reply, finalContent, model, finalPayload.stats, finalPromptTokens);
            }
            return sendContent(reply, finalContent, model, finalPromptTokens, finalPayload.stats);
          }
        }
      if (hasToolResult && responseText.trim()) {
        const extractedFinal = extractPlannerFinal(responseText);
        const finalContent = extractedFinal ?? responseText;
        if (stream) {
          return sendStreamContent(reply, finalContent, model, glmStats, responsePromptTokens);
        }
        return sendContent(reply, finalContent, model, responsePromptTokens, glmStats);
      }
        const fallbackTools = allowHeuristicTools
          ? inferReadToolCall(toolRegistry, lastUser) ||
            inferListToolCall(toolRegistry, lastUser) ||
            inferSearchToolCall(toolRegistry, lastUser)
          : null;
        if (fallbackTools) {
          return guardAndSendToolCalls(
            reply,
            fallbackTools,
            model,
            stream,
            streamHeaders,
            buildToolUsage(responsePromptTokens, fallbackTools),
            responsePromptTokens,
            glmStats,
            "heuristic",
            toolRegistry,
          );
        }
        if (!toolChoiceRequired) {
          const finalPayload = buildInstructionMessages(
            "Answer the user directly. Return ONLY a JSON object matching the schema (actions empty, include final). No extra text or analysis.",
            messages,
            [],
          );
          const finalText = await collectGlmResponse(client, activeChatId, finalPayload.messages, {
            enableThinking: enableThinkingFinal,
            features: featureOverrides,
            includeThinking: false,
            includeHistory: useHistoryThisRequest,
          });
          const finalPromptTokens = estimateMessagesTokens(finalPayload.messages);
          const finalContent = extractPlannerFinal(finalText) ?? finalText;
          if (stream) {
            return sendStreamContent(reply, finalContent, model, finalPayload.stats, finalPromptTokens);
          }
          return sendContent(reply, finalContent, model, finalPromptTokens, finalPayload.stats);
        }
        const fallback = openaiContentResponse(
          "Unable to generate tool call.",
          model,
          buildUsage(responsePromptTokens, "Unable to generate tool call."),
        );
        if (stream) {
          return sendStreamContent(reply, "Unable to generate tool call.", model, glmStats, responsePromptTokens);
        }
        applyResponseHeaders(reply, glmStats);
        return reply.send(fallback);
      }

      let parsedData = parsed.data;
      if (PROXY_DEBUG) {
        console.log("proxy_debug parsed_actions:", parsedData.actions.length);
        if (parsedData.actions.length) {
          console.log("proxy_debug action_tools:", parsedData.actions.map((a) => a.tool).join(","));
        }
      }

      const structural = validatePlannerActions(parsedData.actions as any);
      if (!structural.ok) {
        const content = `Blocked invalid plan (${structural.reason}).`;
        if (stream) {
          return sendStreamContent(reply, content, model, glmStats, responsePromptTokens);
        }
        return sendContent(reply, content, model, responsePromptTokens, glmStats);
      }

      if (hasToolResult && parsedData.actions.length > 0 && toolResultCount >= maxToolLoops) {
        if (PROXY_DEBUG) {
          console.log("proxy_debug tool_loop_limit: true");
        }
        const finalPayload = buildInstructionMessages(
          "Tool loop limit reached. Use the tool results above to answer the user. Return ONLY a JSON object matching the schema (actions empty, include final). No extra text or analysis.",
          messages,
          [],
        );
        const finalText = await collectGlmResponse(client, activeChatId, finalPayload.messages, {
          enableThinking: enableThinkingFinal,
          features: featureOverrides,
          includeThinking: false,
          includeHistory: useHistoryThisRequest,
        });
        const finalPromptTokens = estimateMessagesTokens(finalPayload.messages);
        const finalContent = extractPlannerFinal(finalText) ?? finalText;
        if (stream) {
          return sendStreamContent(reply, finalContent, model, finalPayload.stats, finalPromptTokens);
        }
        return sendContent(reply, finalContent, model, finalPromptTokens, finalPayload.stats);
      }

      if (parsedData.actions.length === 0) {
        if (!hasToolResult) {
          const fallbackTools = allowHeuristicTools
            ? inferReadToolCall(toolRegistry, lastUser) ||
              inferListToolCall(toolRegistry, lastUser) ||
              inferSearchToolCall(toolRegistry, lastUser)
            : null;
          if (fallbackTools) {
            return guardAndSendToolCalls(
              reply,
              fallbackTools,
              model,
              stream,
              streamHeaders,
              buildToolUsage(responsePromptTokens, fallbackTools),
              responsePromptTokens,
              glmStats,
              "heuristic",
              toolRegistry,
            );
          }
        }
        const content = parsedData.final || "";
        if (stream) {
          return sendStreamContent(reply, content, model, glmStats, responsePromptTokens);
        }
        return sendContent(reply, content, model, responsePromptTokens, glmStats);
      }

      const invalid = parsedData.actions.find((action) => !findTool(toolRegistry, action.tool));
      if (invalid) {
        const content = `Unknown tool: ${invalid.tool}`;
        if (stream) {
          return sendStreamContent(reply, content, model, glmStats, responsePromptTokens);
        }
        return sendContent(reply, content, model, responsePromptTokens, glmStats);
      }

      const toolCalls = parsedData.actions.map((action, idx) => {
        const toolInfo = findTool(toolRegistry, action.tool);
        const toolName = toolInfo?.tool.function?.name || toolInfo?.tool.name || action.tool;
        let args = normalizeArgsForTool(toolInfo, action.args || {});

        // Repair common planner mistakes: missing path/filePath on file tools.
        // We infer the most recent file path mentioned in the conversation (often the file just created).
        const normalizedTool = String(toolName || "").toLowerCase().replace(/[_-]/g, "");
        const needsPath =
          normalizedTool === "read" ||
          normalizedTool === "readfile" ||
          normalizedTool === "write" ||
          normalizedTool === "writefile" ||
          normalizedTool === "edit" ||
          normalizedTool === "editfile";
        const hasPath =
          args.path != null ||
          (args as any).filePath != null ||
          (args as any).file_path != null;
        if (needsPath && !hasPath) {
          const inferred = inferRecentFilePath(sanitizedMessages);
          if (inferred) {
            const key =
              toolInfo?.argKeys?.includes("filePath") ? "filePath" : "path";
            args = { ...args, [key]: inferred };
          }
        }
        return {
          id: `call_${crypto.randomUUID().slice(0, 8)}`,
          index: idx,
          type: "function",
          function: {
            name: toolName,
            arguments: JSON.stringify(args),
          },
        };
      });

      return guardAndSendToolCalls(
        reply,
        toolCalls,
        model,
        stream,
        streamHeaders,
        buildToolUsage(responsePromptTokens, toolCalls),
        responsePromptTokens,
        glmStats,
        "planner",
        toolRegistry,
      );
    }

    if (stream) {
      const activeChatId = await getChatId();
      if (tools.length > 0 && !shouldAttemptTools) {
        const fullText = await collectGlmResponse(client, activeChatId, glmMessages, {
          enableThinking: enableThinkingFinal,
          features: featureOverrides,
          includeThinking: false,
          includeHistory: useHistoryThisRequest,
        });
        const rawToolCalls = parseRawToolCalls(fullText, toolRegistry);
        if (rawToolCalls) {
          if (isRawToolCallsAllowed(rawToolCalls)) {
            return guardAndSendToolCalls(
              reply,
              rawToolCalls,
              model,
              true,
              streamHeaders,
              buildToolUsage(responsePromptTokens, rawToolCalls),
              responsePromptTokens,
              glmStats,
              "raw",
              toolRegistry,
            );
          }
          if (PROXY_DEBUG) {
            console.log("proxy_debug raw_tool_calls_blocked: true");
          }
        }
        return sendStreamContent(reply, fullText, model, glmStats, responsePromptTokens);
      }
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream", ...streamHeaders });
      let parentId: string | null = null;
      try {
        parentId = await client.getCurrentMessageId(activeChatId);
      } catch {
        parentId = null;
      }
      const generator = client.sendMessage({
        chatId: activeChatId,
        messages: glmMessages,
        includeHistory: useHistoryThisRequest,
        enableThinking: enableThinkingFinal,
        features: featureOverrides,
        parentMessageId: parentId,
      });
      const streamId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
      const created = Math.floor(Date.now() / 1000);
      let sentRole = false;
      let streamedContent = "";
      for await (const chunk of generator) {
        if (chunk.type === "thinking") {
          const payload = {
            id: streamId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { reasoning_content: chunk.data }, finish_reason: null }],
          };
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
          continue;
        }

        if (chunk.type === "thinking_end") {
          continue;
        }

        if (chunk.type !== "content") continue;
        streamedContent += chunk.data;
        const payload = {
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: sentRole ? { content: chunk.data } : { role: "assistant", content: chunk.data },
              finish_reason: null,
            },
          ],
        };
        sentRole = true;
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
      const finalPayload: Record<string, unknown> = {
        id: streamId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      if (PROXY_INCLUDE_USAGE) {
        finalPayload.usage = buildUsage(responsePromptTokens, streamedContent);
      }
      reply.raw.write(`data: ${JSON.stringify(finalPayload)}\n\n`);
      reply.raw.write("data: [DONE]\n\n");
      return reply.raw.end();
    }

    const activeChatId = await getChatId();
    const content = await collectGlmResponse(client, activeChatId, glmMessages, {
      enableThinking: enableThinkingFinal,
      features: featureOverrides,
      includeThinking: false,
      includeHistory: useHistoryThisRequest,
    });
    if (tools.length > 0) {
      const rawToolCalls = parseRawToolCalls(content, toolRegistry);
      if (rawToolCalls) {
        applyResponseHeaders(reply, glmStats);
        return reply.send(openaiToolResponse(rawToolCalls, model));
      }
    }
    return sendContent(reply, content, model, responsePromptTokens, glmStats);
  };

  return handleChatCompletion;
};

export { createChatCompletionHandler };

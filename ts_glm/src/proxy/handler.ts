import crypto from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { GLMClient } from "../glmClient.js";
import { extractFirstJsonObject, repairPlannerJson } from "web-wrapper-protocol";
import { debugDump, debugLog, safeJson, truncate, writeDebugDump } from "./debug.js";
import {
  ACTIONABLE_KEYWORDS,
  DEFAULT_MODEL,
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
  PROXY_STRIP_HISTORY,
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
import {
  collectGlmResponseDetailed,
  convertMessages,
  stripDirectivesFromContent,
} from "./messages.js";
import { openaiContentResponse, sendToolCalls, streamContent } from "./openai.js";
import {
  applyMutationActionBoundary,
  isRawToolCallsAllowed,
  validatePlannerActions,
  validateToolCalls,
} from "./handler/guards.js";
import {
  inferExplicitToolCalls,
  inferListToolCall,
  inferReadToolCall,
  inferSearchToolCall,
} from "./tools/infer.js";
import {
  buildToolRegistry,
  findTool,
  isNetworkTool,
  normalizeArgsForTool,
  type ToolInfo,
} from "./tools/registry.js";
import {
  filterPlannerActions,
  filterPlannerTools,
  shouldAllowTodoTools,
} from "./tools/policy.js";
import { parseRawToolCalls, tryParseModelOutput, tryRepairPlannerOutput } from "./tools/parse.js";
import { inferRecentFilePath } from "./tools/path.js";

type ChatCompletionHandlerDeps = {
  client: GLMClient;
  ensureChat: () => Promise<string>;
  resetChat: () => void;
};

type RawDispatchContext = {
  lastUser: string;
  hasToolResult: boolean;
  allowTodoWrite: boolean;
  recentFilePath: string | null;
};

type PreparedRawToolCalls = {
  toolCalls: any[];
  signature: string;
};

const createChatCompletionHandler = ({ client, ensureChat, resetChat }: ChatCompletionHandlerDeps) => {
  const contextConfig = getContextConfig();
  const useGlmHistory = PROXY_USE_GLM_HISTORY;
  const alwaysSendSystem = PROXY_ALWAYS_SEND_SYSTEM;
  let lastMessages: any[] = [];
  let lastSignature = "";
  let lastRawDispatchSignature = "";
  let lastRawDispatchUser = "";
  const pendingConfirmations = new Map<
    string,
    { toolCalls: any[]; blockedReason: string; createdAt: number }
  >();
  const PENDING_CONFIRM_TTL_MS = 10 * 60 * 1000;

  const previewMessage = (msg: any) => {
    const role = msg?.role;
    if (role === "tool") {
      const content = typeof msg?.content === "string" ? msg.content : safeJson(msg?.content);
      return {
        role,
        tool_call_id: msg?.tool_call_id,
        content: truncate(content, 400),
      };
    }
    const content = extractContentText(msg?.content);
    return {
      role,
      name: msg?.name,
      content: truncate(content || "", 400),
      tool_calls: Array.isArray(msg?.tool_calls)
        ? msg.tool_calls.map((c: any) => ({
            id: c?.id,
            type: c?.type,
            name: c?.function?.name,
          }))
        : undefined,
    };
  };

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

  const buildMessages = (sourceMessages: any[], toolList: any[], extraSystem?: string) => {
    const converted = convertMessages(sourceMessages, toolList, {
      toolMaxLines: contextConfig.toolMaxLines,
      toolMaxChars: contextConfig.toolMaxChars,
      extraSystem,
    });
    return compactMessages(converted, contextConfig);
  };

  const buildInstructionMessages = (
    systemContent: string,
    sourceMessages: any[],
    toolList: any[],
    extraSystem?: string,
  ) => {
    const base = buildMessages(sourceMessages, toolList, extraSystem);
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
    reasoningContent?: string,
  ) => {
    const headers = buildStreamHeaders(stats);
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", ...headers });
    const usage =
      promptTokens !== undefined ? buildUsage(promptTokens, content) : undefined;
    reply.raw.write(streamContent(content, model, usage, reasoningContent));
    return reply.raw.end();
  };

  const sendContent = (
    reply: FastifyReply,
    content: string,
    model: string,
    promptTokens: number,
    stats?: ContextStats,
  ) => {
    debugDump("response_content", { model, content: truncate(content || "", 2000) });
    applyResponseHeaders(reply, stats);
    return reply.send(openaiContentResponse(content, model, buildUsage(promptTokens, content)));
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

  const normalizeToolName = (value: unknown) => String(value || "").toLowerCase().replace(/[_-]/g, "");

  const EDIT_TOOL_NAMES = new Set(["edit", "editfile", "applypatch", "patch"]);

  const sortJsonValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortJsonValue);
    if (!value || typeof value !== "object") return value;
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const out: Record<string, unknown> = {};
    for (const [key, nested] of entries) out[key] = sortJsonValue(nested);
    return out;
  };

  const stableStringify = (value: unknown): string => {
    try {
      return JSON.stringify(sortJsonValue(value));
    } catch {
      return "";
    }
  };

  const parseToolCallArgs = (call: any): Record<string, unknown> | null => {
    const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
    if (rawArgs && typeof rawArgs === "object") {
      return rawArgs as Record<string, unknown>;
    }
    if (typeof rawArgs !== "string") return {};
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      return {};
    } catch {
      return null;
    }
  };

  const getFirstStringArg = (args: Record<string, unknown>, keys: string[]): string | null => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string") return value;
    }
    return null;
  };

  const isNoOpEditArgs = (toolName: string, args: Record<string, unknown>): boolean => {
    if (!EDIT_TOOL_NAMES.has(normalizeToolName(toolName))) return false;
    const oldString = getFirstStringArg(args, ["oldString", "old_string", "oldText", "old_text"]);
    const newString = getFirstStringArg(args, ["newString", "new_string", "newText", "new_text"]);
    return oldString !== null && newString !== null && oldString === newString;
  };

  const buildToolCallSignature = (call: any): string | null => {
    const toolName = normalizeToolName(call?.function?.name || call?.name || "");
    if (!toolName) return null;
    const args = parseToolCallArgs(call);
    if (args === null) return null;
    const payload = stableStringify(args);
    if (!payload) return null;
    return `${toolName}|${payload}`;
  };

  const prepareRawToolCalls = (
    rawCalls: any[],
    context: RawDispatchContext,
    registry?: Map<string, ToolInfo>,
  ): PreparedRawToolCalls | null => {
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) return null;
    const seen = new Set<string>();
    const keptCalls: any[] = [];
    const signatures: string[] = [];
    let droppedTodoWrite = 0;
    let droppedNoOpEdits = 0;
    let droppedDuplicates = 0;
    let repairedMissingPath = 0;

    for (const call of rawCalls) {
      const toolName = normalizeToolName(call?.function?.name || call?.name || "");
      if (!toolName) continue;
      if (toolName === "todowrite" && !context.allowTodoWrite) {
        droppedTodoWrite += 1;
        continue;
      }

      const args = parseToolCallArgs(call);
      if (args && isNoOpEditArgs(toolName, args)) {
        droppedNoOpEdits += 1;
        continue;
      }
      if (args && context.hasToolResult && context.recentFilePath) {
        const isPathRepairableTool =
          toolName === "read" ||
          toolName === "readfile" ||
          toolName === "write" ||
          toolName === "writefile" ||
          toolName === "edit" ||
          toolName === "editfile" ||
          toolName === "applypatch" ||
          toolName === "patch";
        const hasPath =
          typeof args.path === "string" && args.path.trim().length > 0
            ? true
            : typeof (args as any).filePath === "string" && String((args as any).filePath).trim().length > 0
              ? true
              : typeof (args as any).file_path === "string" && String((args as any).file_path).trim().length > 0
                ? true
                : false;
        if (isPathRepairableTool && !hasPath) {
          const resolvedName = String(call?.function?.name || call?.name || "");
          const toolInfo = registry ? findTool(registry, resolvedName || toolName) : null;
          const pathKey = toolInfo?.argKeys?.includes("filePath")
            ? "filePath"
            : toolInfo?.argKeys?.includes("file_path")
              ? "file_path"
              : toolInfo?.argKeys?.includes("path")
                ? "path"
                : "path";
          (args as any)[pathKey] = context.recentFilePath;
          if (call?.function && typeof call.function === "object") {
            call.function.arguments = JSON.stringify(args);
          } else if (call && typeof call === "object") {
            call.arguments = JSON.stringify(args);
          }
          repairedMissingPath += 1;
        }
      }

      const signature = buildToolCallSignature(call);
      if (signature && seen.has(signature)) {
        droppedDuplicates += 1;
        continue;
      }
      if (signature) {
        seen.add(signature);
        signatures.push(signature);
      }
      keptCalls.push(call);
    }

    if (PROXY_DEBUG && (droppedTodoWrite || droppedNoOpEdits || droppedDuplicates || repairedMissingPath)) {
      console.log(
        "proxy_debug raw_preprocess:",
        JSON.stringify({
          droppedTodoWrite,
          droppedNoOpEdits,
          droppedDuplicates,
          repairedMissingPath,
          inputCount: rawCalls.length,
          keptCount: keptCalls.length,
        }),
      );
    }

    if (keptCalls.length === 0) return null;
    const batchSignature = signatures.join("||");
    if (
      context.hasToolResult &&
      context.lastUser &&
      batchSignature &&
      batchSignature === lastRawDispatchSignature &&
      context.lastUser === lastRawDispatchUser
    ) {
      if (PROXY_DEBUG) {
        console.log(
          "proxy_debug repeated_raw_suppressed:",
          JSON.stringify({
            signature: truncate(batchSignature, 240),
          }),
        );
      }
      return null;
    }

    return {
      toolCalls: keptCalls,
      signature: batchSignature,
    };
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
    rawContext?: RawDispatchContext & { rawSignature?: string },
    reasoningContent?: string,
  ) => {
    if (!registry) {
      const content = "Tool registry missing; cannot validate tool calls.";
      if (stream) {
        return sendStreamContent(reply, content, model, stats, promptTokens);
      }
      return sendContent(reply, content, model, promptTokens, stats);
    }
    let boundedToolCalls = toolCalls;
    let boundedUsage = usage;
    if (PROXY_MAX_ACTIONS_PER_TURN > 0 && toolCalls.length > PROXY_MAX_ACTIONS_PER_TURN) {
      boundedToolCalls = toolCalls.slice(0, PROXY_MAX_ACTIONS_PER_TURN);
      boundedUsage = buildToolUsage(promptTokens, boundedToolCalls);
      if (PROXY_DEBUG) {
        console.log(
          "proxy_debug too_many_actions: truncated_tool_calls",
          JSON.stringify({
            source,
            originalCount: toolCalls.length,
            returnedCount: boundedToolCalls.length,
          }),
        );
      }
    }
    const guard = validateToolCalls(boundedToolCalls, source, registry);
    if (!guard.ok) {
      debugDump("guard_block", {
        source,
        reason: guard.reason,
        hasConfirmation: Boolean(guard.confirmationToolCalls?.length),
        toolCalls: boundedToolCalls?.map((c: any) => ({
          id: c?.id,
          name: c?.function?.name || c?.name,
        })),
      });
      if (guard.confirmationToolCalls && guard.confirmationToolCalls.length > 0) {
        if (guard.pendingConfirmation?.id) {
          pendingConfirmations.set(guard.pendingConfirmation.id, {
            toolCalls: guard.pendingConfirmation.toolCalls,
            blockedReason: guard.pendingConfirmation.blockedReason,
            createdAt: Date.now(),
          });
          debugDump("pending_confirmation_set", {
            id: guard.pendingConfirmation.id,
            blockedReason: guard.pendingConfirmation.blockedReason,
            toolCalls: guard.pendingConfirmation.toolCalls?.map((c: any) => ({
              id: c?.id,
              name: c?.function?.name || c?.name,
            })),
          });
        }
        const confirmUsage = buildToolUsage(promptTokens, guard.confirmationToolCalls);
        applyResponseHeaders(reply, stats);
        return sendToolCalls(
          reply,
          guard.confirmationToolCalls,
          model,
          stream,
          headers,
          confirmUsage,
          reasoningContent,
        );
      }
      const content = `Blocked unsafe tool call (${guard.reason}).`;
      if (stream) {
        return sendStreamContent(reply, content, model, stats, promptTokens);
      }
      return sendContent(reply, content, model, promptTokens, stats);
    }
    applyResponseHeaders(reply, stats);
    if (source === "raw" && rawContext?.rawSignature) {
      lastRawDispatchSignature = rawContext.rawSignature;
      lastRawDispatchUser = rawContext.lastUser;
    }
    debugDump("response_tool_calls", {
      model,
      source,
      toolCalls: boundedToolCalls.map((c: any) => ({
        id: c?.id,
        name: c?.function?.name || c?.name,
        argumentsPreview:
          typeof c?.function?.arguments === "string" ? truncate(c.function.arguments, 1200) : undefined,
      })),
    });
    return sendToolCalls(
      reply,
      boundedToolCalls,
      model,
      stream,
      headers,
      boundedUsage,
      reasoningContent,
    );
  };

  const isAffirmativeConfirmation = (value: string): boolean => {
    const text = (value || "").trim().toLowerCase();
    if (!text) return false;
    const isAffirmativeChoice = (choice: string): boolean => {
      const normalized = choice.trim().toLowerCase();
      if (!normalized) return false;
      if (
        [
          "y",
          "yes",
          "true",
          "ok",
          "okay",
          "proceed",
          "proceed (recommended)",
          "continue",
          "confirm",
          "approved",
          "allow",
          "1",
        ].includes(normalized)
      ) {
        return true;
      }
      if (/^(yes|ok|okay|proceed|continue|confirm|approved|allow)\b/.test(normalized)) {
        return true;
      }
      return false;
    };
    if (isAffirmativeChoice(text)) {
      return true;
    }
    const answeredMatch = text.match(/=\s*"([^"]+)"/);
    if (answeredMatch && isAffirmativeChoice(answeredMatch[1] || "")) {
      return true;
    }
    if (/user has answered your questions:/i.test(text) && /proceed\s*\(recommended\)/i.test(text)) {
      return true;
    }
    // Some UIs may return JSON.
    try {
      const parsed = JSON.parse(text);
      if (parsed === true) return true;
      if (parsed && typeof parsed === "object") {
        const ok = (parsed as any).ok ?? (parsed as any).confirmed ?? (parsed as any).confirm;
        if (ok === true) return true;
        const answer =
          (parsed as any).answer ??
          (parsed as any).selected ??
          (parsed as any).selection ??
          (parsed as any).value;
        if (typeof answer === "string" && isAffirmativeChoice(answer)) {
          return true;
        }
      }
    } catch {
      // ignore
    }
    return false;
  };

  const tryHandlePendingConfirmation = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): { handled: boolean } => {
    // Best-effort cleanup.
    const now = Date.now();
    for (const [id, entry] of pendingConfirmations.entries()) {
      if (now - entry.createdAt > PENDING_CONFIRM_TTL_MS) pendingConfirmations.delete(id);
    }

    const body = request.body as any;
    const model = body.model || DEFAULT_MODEL;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return { handled: false };

    const last = messages[messages.length - 1];
    if (last?.role !== "tool") return { handled: false };
    const toolCallId = String(last?.tool_call_id || last?.toolCallId || "").trim();
    if (!toolCallId) return { handled: false };

    const pending = pendingConfirmations.get(toolCallId);
    if (!pending) return { handled: false };

    pendingConfirmations.delete(toolCallId);
    const content = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    debugDump("confirmation_tool_result", {
      tool_call_id: toolCallId,
      content: truncate(content, 1200),
    });
    if (!isAffirmativeConfirmation(content)) {
      debugDump("pending_confirmation_declined", { id: toolCallId, blockedReason: pending.blockedReason });
      const stream = Boolean(body.stream);
      if (stream) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent("Cancelled.", model));
        reply.raw.end();
      } else {
        reply.send(openaiContentResponse("Cancelled.", model));
      }
      return { handled: true };
    }

    // User approved: replay the blocked tool calls directly.
    debugDump("pending_confirmation_approved", {
      id: toolCallId,
      blockedReason: pending.blockedReason,
      toolCalls: pending.toolCalls?.map((c: any) => ({ id: c?.id, name: c?.function?.name || c?.name })),
    });
    const stream = Boolean(body.stream);
    const headers: Record<string, string> = {};
    sendToolCalls(reply, pending.toolCalls, model, stream, headers, undefined);
    return { handled: true };
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
    const requestId = crypto.randomUUID().slice(0, 8);
    reply.header("x-proxy-request-id", requestId);
    const confirmHandled = tryHandlePendingConfirmation(request, reply);
    if (confirmHandled.handled) return;
    const body = request.body as any;
    const model = body.model || DEFAULT_MODEL;
    const messages = body.messages || [];
    const rawTools = Array.isArray(body.tools) ? body.tools : [];
    const stream = Boolean(body.stream);
    const toolChoice = body.tool_choice;
    debugDump("request", {
      requestId,
      http: {
        method: (request as any).method,
        url: (request as any).url,
        headers: (request as any).headers,
      },
      model,
      stream,
      toolChoice,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      lastMessage: Array.isArray(messages) && messages.length ? previewMessage(messages[messages.length - 1]) : null,
      tools: rawTools.map((t: any) => t?.function?.name || t?.name || "tool"),
    });
    await writeDebugDump("http_request", {
      requestId,
      method: (request as any).method,
      url: (request as any).url,
      headers: (request as any).headers,
      body,
    });
    const allowWebSearch = PROXY_ALLOW_WEB_SEARCH;
    let chatId: string | null = null;
    const getChatId = async () => {
      if (!chatId) {
        chatId = await ensureChat();
        debugLog("request", requestId, "active_chat_id:", chatId);
      }
      return chatId;
    };

    let tools = allowWebSearch ? rawTools : rawTools.filter((tool: any) => !isNetworkTool(tool));

    // Prefer OpenCode's built-in `question` tool (if present). If missing, inject a minimal schema
    // so the model can request confirmation for guarded actions.
    const hasConfirmTool = tools.some((tool: any) => {
      const fn = tool?.function || {};
      const name = String(fn.name || tool?.name || "");
      const norm = name.toLowerCase().replace(/[_-]/g, "");
      return norm === "question" || norm === "askquestion" || norm === "confirm";
    });
    if (!hasConfirmTool) {
      tools.push({
        function: {
          name: "question",
          description: "Ask the user for confirmation before a dangerous action.",
          parameters: {
            type: "object",
            properties: {
              question: { type: "string" },
            },
            required: ["question"],
          },
        },
      });
    }

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
    if (PROXY_STRIP_HISTORY) {
      const hasToolMessages = sanitizedMessages.some((msg: any) => msg?.role === "tool" || msg?.tool_call_id);
      if (!hasToolMessages) {
        const systemMessages = sanitizedMessages.filter((msg: any) => msg?.role === "system");
        const lastUserMessage = (() => {
          for (let i = sanitizedMessages.length - 1; i >= 0; i -= 1) {
            if (sanitizedMessages[i]?.role === "user") return sanitizedMessages[i];
          }
          return null;
        })();
        sanitizedMessages = [
          ...systemMessages,
          ...(lastUserMessage ? [lastUserMessage] : []),
        ];
      }
    }
    const last = sanitizedMessages[sanitizedMessages.length - 1];
    let hasToolResult = Boolean(last && (last.role === "tool" || last.tool_call_id));
    let toolResultCount = sanitizedMessages.filter((m: any) => m.role === "tool" || m.tool_call_id).length;
    const maxToolLoops = PROXY_TOOL_LOOP_LIMIT > 0 ? PROXY_TOOL_LOOP_LIMIT : Number.POSITIVE_INFINITY;
    if (PROXY_TEST_MODE && testDirectives.forceToolResult) {
      hasToolResult = true;
      if (Number.isFinite(maxToolLoops)) {
        toolResultCount = Math.max(toolResultCount, maxToolLoops);
      }
    }
    const allowTodoWrite = shouldAllowTodoTools(lastUser);
    const filteredTools = filterPlannerTools(tools, { allowTodoTools: allowTodoWrite });
    tools = filteredTools.tools;
    if (PROXY_DEBUG && filteredTools.droppedTodoTools.length > 0) {
      console.log(
        "proxy_debug tool_policy_dropped:",
        JSON.stringify({
          droppedTodoTools: filteredTools.droppedTodoTools,
        }),
      );
    }

    const toolRegistry = buildToolRegistry(tools);
    const bodyFeatures = body?.features && typeof body.features === "object" ? body.features : {};
    const featureOverrides: Record<string, unknown> = { ...bodyFeatures };
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
    const rawDispatchContext: RawDispatchContext = {
      lastUser,
      hasToolResult,
      allowTodoWrite,
      recentFilePath: inferRecentFilePath(sanitizedMessages),
    };
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
    const runtimeWorkspaceSystem = [
      "Runtime workspace context:",
      `- cwd: ${process.cwd()}`,
      "Path policy: use repo-relative paths for tool args whenever possible.",
      "Never emit read/write/edit/apply_patch actions without an explicit file path.",
    ].join("\n");
    const plannerSystemText = [systemText, runtimeWorkspaceSystem].filter(Boolean).join("\n\n");
    const baseMessages = buildMessages(
      sanitizedMessages,
      shouldAttemptTools ? tools : [],
      shouldAttemptTools ? plannerSystemText : systemText,
    );
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
      const signature = buildSignature(
        shouldAttemptTools ? tools : [],
        shouldAttemptTools ? plannerSystemText : systemText,
      );
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
      const extraSystem = alwaysSendSystem
        ? shouldAttemptTools
          ? plannerSystemText
          : systemText
        : reseed
          ? shouldAttemptTools
            ? plannerSystemText
            : systemText
          : "";
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
      lastSignature = buildSignature(
        shouldAttemptTools ? tools : [],
        shouldAttemptTools ? plannerSystemText : systemText,
      );
    }
    const POST_TOOL_SYSTEM = [
      "You have received tool results.",
      "Continue the task.",
      "If more tools are needed, return ONLY a JSON object matching the schema with actions.",
      "If no further tools are needed, return ONLY a JSON object matching the schema with actions empty and include final.",
      "No extra text or analysis.",
    ].join(" ");

    if (hasToolResult && shouldAttemptTools) {
      if (useHistoryThisRequest) {
        const toolSeed = tools;
        const instructedMessages = convertMessages(sanitizedMessages, toolSeed, {
          toolMaxLines: contextConfig.toolMaxLines,
          toolMaxChars: contextConfig.toolMaxChars,
          extraSystem: plannerSystemText,
        });
        const withInstruction = compactMessages(
          [
            {
              role: "system",
              content: POST_TOOL_SYSTEM,
            },
            ...instructedMessages,
          ],
          contextConfig,
        );
        glmMessages = withInstruction.messages;
        glmStats = withInstruction.stats;
      } else {
        const instructed = buildInstructionMessages(
          POST_TOOL_SYSTEM,
          sanitizedMessages,
          tools,
          plannerSystemText,
        );
        glmMessages = instructed.messages;
        glmStats = instructed.stats;
      }
    }
    let responsePromptTokens = estimateMessagesTokens(glmMessages);
    const streamHeaders = buildStreamHeaders(glmStats);
    let lastModelThinking = "";
    const collectModelResponse = async (
      chatId: string,
      requestMessages: { role: string; content: string }[],
      options?: { parentMessageId?: string | null },
    ) => {
      const detailed = await collectGlmResponseDetailed(client, chatId, requestMessages, {
        enableThinking: enableThinkingFinal,
        features: featureOverrides,
        includeHistory: useHistoryThisRequest,
        parentMessageId: options?.parentMessageId,
      });
      lastModelThinking = detailed.thinking;
      return detailed.content;
    };

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
      let plannerParentMessageId: string | null | undefined = undefined;
      if (!useHistoryThisRequest) {
        // Planner retries can otherwise incur repeated getChat() calls via getCurrentMessageId().
        // Resolve once per turn and reuse across retries.
        try {
          plannerParentMessageId = await client.getCurrentMessageId(activeChatId);
        } catch {
          plannerParentMessageId = null;
        }
      }
      let responseText = await collectModelResponse(activeChatId, glmMessages, {
        parentMessageId: plannerParentMessageId,
      });
      const initialResponseText = responseText;
      if (PROXY_DEBUG) {
        const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
        console.log("proxy_debug model_raw:", preview);
      }
      const earlyRawToolCalls = parseRawToolCalls(responseText, toolRegistry);
      if (earlyRawToolCalls && isRawToolCallsAllowed(earlyRawToolCalls)) {
        const prepared = prepareRawToolCalls(earlyRawToolCalls, rawDispatchContext, toolRegistry);
        if (!prepared) {
          if (PROXY_DEBUG) {
            console.log("proxy_debug raw_tool_calls_suppressed: true");
          }
        } else {
        return guardAndSendToolCalls(
          reply,
          prepared.toolCalls,
          model,
          stream,
          streamHeaders,
          buildToolUsage(responsePromptTokens, prepared.toolCalls),
          responsePromptTokens,
          glmStats,
          "raw",
          toolRegistry,
          {
            ...rawDispatchContext,
            rawSignature: prepared.signature,
          },
          lastModelThinking,
        );
        }
      } else if (earlyRawToolCalls && PROXY_DEBUG) {
        console.log("proxy_debug raw_tool_calls_blocked: true");
      }
      let parsed = tryParseModelOutput(responseText, false);
      if (!parsed.ok) {
        const repaired = tryRepairPlannerOutput(responseText);
        if (repaired) {
          parsed = { ok: true, data: repaired };
        }
      }
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
        responseText = await collectModelResponse(activeChatId, correctedMessages, {
          parentMessageId: plannerParentMessageId,
        });
        responsePromptTokens = estimateMessagesTokens(correctedMessages);
        if (PROXY_DEBUG) {
          const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
          console.log("proxy_debug model_retry_raw:", preview);
        }
        parsed = tryParseModelOutput(responseText, false);
        if (!parsed.ok) {
          const repaired = tryRepairPlannerOutput(responseText);
          if (repaired) {
            parsed = { ok: true, data: repaired };
          }
        }
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
        responseText = await collectModelResponse(activeChatId, stricterMessages, {
          parentMessageId: plannerParentMessageId,
        });
        responsePromptTokens = estimateMessagesTokens(stricterMessages);
        if (PROXY_DEBUG) {
          const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
          console.log("proxy_debug model_retry2_raw:", preview);
        }
        parsed = tryParseModelOutput(responseText, false);
        if (!parsed.ok) {
          const repaired = tryRepairPlannerOutput(responseText);
          if (repaired) {
            parsed = { ok: true, data: repaired };
          }
        }
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
          const prepared = prepareRawToolCalls(maybeRawToolCalls, rawDispatchContext, toolRegistry);
          if (prepared) {
            return guardAndSendToolCalls(
              reply,
              prepared.toolCalls,
              model,
              stream,
              streamHeaders,
              buildToolUsage(responsePromptTokens, prepared.toolCalls),
              responsePromptTokens,
              glmStats,
              "raw",
              toolRegistry,
              {
                ...rawDispatchContext,
                rawSignature: prepared.signature,
              },
              lastModelThinking,
            );
          }
          if (PROXY_DEBUG) {
            console.log("proxy_debug raw_tool_calls_suppressed: true");
          }
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
            const prepared = prepareRawToolCalls(rawToolCalls, rawDispatchContext, toolRegistry);
            if (prepared) {
              return guardAndSendToolCalls(
                reply,
                prepared.toolCalls,
                model,
                stream,
                streamHeaders,
                buildToolUsage(responsePromptTokens, prepared.toolCalls),
                responsePromptTokens,
                glmStats,
                "raw",
                toolRegistry,
                {
                  ...rawDispatchContext,
                  rawSignature: prepared.signature,
                },
                lastModelThinking,
              );
            }
            if (PROXY_DEBUG) {
              console.log("proxy_debug raw_tool_calls_suppressed: true");
            }
          }
          if (PROXY_DEBUG) {
            console.log("proxy_debug raw_tool_calls_blocked: true");
          }
        }
      if (hasToolResult) {
        const looksLikePlannerJson = PLANNER_JSON_HINT_REGEX.test(responseText) || responseText.trim().startsWith("{");
        if (looksLikePlannerJson) {
            const finalPayload = buildInstructionMessages(POST_TOOL_SYSTEM, messages, tools);
            const finalText = await collectModelResponse(activeChatId, finalPayload.messages);
            const finalPromptTokens = estimateMessagesTokens(finalPayload.messages);
            const extractedFinal = extractPlannerFinal(finalText) ?? extractPlannerFinal(responseText);
            const finalContent = extractedFinal ?? finalText;
            if (stream) {
              return sendStreamContent(
                reply,
                finalContent,
                model,
                finalPayload.stats,
                finalPromptTokens,
                lastModelThinking,
              );
            }
            return sendContent(reply, finalContent, model, finalPromptTokens, finalPayload.stats);
          }
        }
      if (hasToolResult && responseText.trim()) {
        const extractedFinal = extractPlannerFinal(responseText);
        const finalContent = extractedFinal ?? responseText;
        if (stream) {
          return sendStreamContent(
            reply,
            finalContent,
            model,
            glmStats,
            responsePromptTokens,
            lastModelThinking,
          );
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
          const finalText = await collectModelResponse(activeChatId, finalPayload.messages);
          const finalPromptTokens = estimateMessagesTokens(finalPayload.messages);
          const finalContent = extractPlannerFinal(finalText) ?? finalText;
          if (stream) {
            return sendStreamContent(
              reply,
              finalContent,
              model,
              finalPayload.stats,
              finalPromptTokens,
              lastModelThinking,
            );
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
      if (
        PROXY_MAX_ACTIONS_PER_TURN > 0 &&
        Array.isArray(parsedData.actions) &&
        parsedData.actions.length > PROXY_MAX_ACTIONS_PER_TURN
      ) {
        const originalCount = parsedData.actions.length;
        parsedData = {
          ...parsedData,
          actions: parsedData.actions.slice(0, PROXY_MAX_ACTIONS_PER_TURN),
        };
        if (PROXY_DEBUG) {
          console.log(
            "proxy_debug too_many_actions: truncated_planner_actions",
            JSON.stringify({
              originalCount,
              returnedCount: parsedData.actions.length,
            }),
          );
        }
      }
      if (Array.isArray(parsedData.actions) && parsedData.actions.length > 0) {
        const beforePolicy = parsedData.actions.length;
        const policyFiltered = filterPlannerActions(parsedData.actions as any[], {
          allowTodoTools: allowTodoWrite,
        });
        const candidateActions = policyFiltered.actions;
        const filteredTodoCount = policyFiltered.droppedTodoActions;
        let filteredNoOpCount = 0;
        const filtered = candidateActions.filter((action: any) => {
          const toolInfo = findTool(toolRegistry, action?.tool || "");
          const toolName = toolInfo?.tool.function?.name || toolInfo?.tool.name || action?.tool || "";
          const args =
            action?.args && typeof action.args === "object"
              ? (action.args as Record<string, unknown>)
              : {};
          const keep = !isNoOpEditArgs(toolName, args);
          if (!keep) filteredNoOpCount += 1;
          return keep;
        });
        if ((filteredTodoCount > 0 || filteredNoOpCount > 0) && PROXY_DEBUG) {
          console.log(
            "proxy_debug planner_actions_filtered:",
            JSON.stringify({
              originalCount: beforePolicy,
              filteredCount: filtered.length,
              droppedTodoActions: filteredTodoCount,
              droppedNoOpEdits: filteredNoOpCount,
            }),
          );
        }
        parsedData = { ...parsedData, actions: filtered };
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
        const finalText = await collectModelResponse(activeChatId, finalPayload.messages);
        const finalPromptTokens = estimateMessagesTokens(finalPayload.messages);
        const finalContent = extractPlannerFinal(finalText) ?? finalText;
        if (stream) {
          return sendStreamContent(
            reply,
            finalContent,
            model,
            finalPayload.stats,
            finalPromptTokens,
            lastModelThinking,
          );
        }
        return sendContent(reply, finalContent, model, finalPromptTokens, finalPayload.stats);
      }

      if (parsedData.actions.length === 0) {
        if (hasToolResult && !String(parsedData.final || "").trim()) {
          const dispatchRecoveryActions = (
            actions: any[],
            promptTokens: number,
            stats: ContextStats,
          ) => {
            const policyFiltered = filterPlannerActions(actions, {
              allowTodoTools: allowTodoWrite,
            });
            const filteredActions = policyFiltered.actions;
            if (filteredActions.length === 0) return null;
            const structuralRecovery = validatePlannerActions(filteredActions as any);
            if (!structuralRecovery.ok) return null;
            const invalidRecovery = filteredActions.find((action: any) => !findTool(toolRegistry, action?.tool || ""));
            if (invalidRecovery) return null;
            const boundedRecoveryActions = applyMutationActionBoundary(filteredActions as any, toolRegistry);
            const recoveryToolCalls = boundedRecoveryActions.actions.map((action, idx) => {
              const toolInfo = findTool(toolRegistry, action.tool);
              const toolName = toolInfo?.tool.function?.name || toolInfo?.tool.name || action.tool;
              let args = normalizeArgsForTool(toolInfo, action.args || {});
              const normalizedTool = String(toolName || "").toLowerCase().replace(/[_-]/g, "");
              const needsPath = normalizedTool === "read" || normalizedTool === "readfile";
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
              recoveryToolCalls,
              model,
              stream,
              streamHeaders,
              buildToolUsage(promptTokens, recoveryToolCalls),
              promptTokens,
              stats,
              "planner",
              toolRegistry,
              undefined,
              lastModelThinking,
            );
          };

          const parseRecoveryPayload = (text: string) => {
            let parsedRecovery = tryParseModelOutput(text, false);
            if (!parsedRecovery.ok || !parsedRecovery.data) {
              const repairedRecovery = tryRepairPlannerOutput(text);
              if (repairedRecovery) {
                parsedRecovery = { ok: true, data: repairedRecovery };
              }
            }
            return parsedRecovery;
          };

          if (PROXY_DEBUG) {
            console.log("proxy_debug empty_action_recovery: attempt");
          }
          const recoveryPayload = buildInstructionMessages(
            "You received tool results but returned no actionable response. Continue the task. Return ONLY a JSON object matching the schema. If more tools are needed, include actions. Do not return todowrite-only status updates unless the user explicitly asked for a todo/checklist.",
            messages,
            tools,
          );
          const recoveryText = await collectModelResponse(activeChatId, recoveryPayload.messages);
          const recoveryPromptTokens = estimateMessagesTokens(recoveryPayload.messages);

          const recoveryRawToolCalls = parseRawToolCalls(recoveryText, toolRegistry);
          if (recoveryRawToolCalls && isRawToolCallsAllowed(recoveryRawToolCalls)) {
            const prepared = prepareRawToolCalls(recoveryRawToolCalls, rawDispatchContext, toolRegistry);
            if (prepared) {
              return guardAndSendToolCalls(
                reply,
                prepared.toolCalls,
                model,
                stream,
                streamHeaders,
                buildToolUsage(recoveryPromptTokens, prepared.toolCalls),
                recoveryPromptTokens,
                recoveryPayload.stats,
                "raw",
                toolRegistry,
                {
                  ...rawDispatchContext,
                  rawSignature: prepared.signature,
                },
                lastModelThinking,
              );
            }
            if (PROXY_DEBUG) {
              console.log("proxy_debug raw_tool_calls_suppressed: true");
            }
          }

          let recovered = parseRecoveryPayload(recoveryText);
          if (recovered.ok && recovered.data && recovered.data.actions.length > 0) {
            const dispatched = dispatchRecoveryActions(
              recovered.data.actions as any,
              recoveryPromptTokens,
              recoveryPayload.stats,
            );
            if (dispatched) {
              return dispatched;
            }
          }

          const recoveredFinal =
            extractPlannerFinal(recoveryText) ||
            (recovered.ok && recovered.data ? recovered.data.final : "") ||
            "No further actions were produced; task may require another explicit user prompt.";
          if (stream) {
            return sendStreamContent(
              reply,
              recoveredFinal,
              model,
              recoveryPayload.stats,
              recoveryPromptTokens,
              lastModelThinking,
            );
          }
          return sendContent(reply, recoveredFinal, model, recoveryPromptTokens, recoveryPayload.stats);
        }
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
          return sendStreamContent(
            reply,
            content,
            model,
            glmStats,
            responsePromptTokens,
            lastModelThinking,
          );
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

      const boundedActions = applyMutationActionBoundary(parsedData.actions as any, toolRegistry);
      if (boundedActions.truncated && PROXY_DEBUG) {
        console.log(
          "proxy_debug mutation_action_boundary: truncated_planner_actions",
          JSON.stringify({
            originalCount: parsedData.actions.length,
            returnedCount: boundedActions.actions.length,
            firstTool: parsedData.actions[0]?.tool || "",
          }),
        );
      }

      const toolCalls = boundedActions.actions.map((action, idx) => {
        const toolInfo = findTool(toolRegistry, action.tool);
        const toolName = toolInfo?.tool.function?.name || toolInfo?.tool.name || action.tool;
        let args = normalizeArgsForTool(toolInfo, action.args || {});

        // Repair common planner mistakes: missing path/filePath on read tools.
        // Never infer a target path for mutation tools (no heuristic mutations).
        const normalizedTool = String(toolName || "").toLowerCase().replace(/[_-]/g, "");
        const needsPath = normalizedTool === "read" || normalizedTool === "readfile";
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
        undefined,
        lastModelThinking,
      );
    }

    if (stream) {
      const activeChatId = await getChatId();
      if (tools.length > 0 && !shouldAttemptTools) {
        const fullText = await collectModelResponse(activeChatId, glmMessages);
        const rawToolCalls = parseRawToolCalls(fullText, toolRegistry);
        if (rawToolCalls) {
          if (isRawToolCallsAllowed(rawToolCalls)) {
            const prepared = prepareRawToolCalls(rawToolCalls, rawDispatchContext, toolRegistry);
            if (prepared) {
              return guardAndSendToolCalls(
                reply,
                prepared.toolCalls,
                model,
                true,
                streamHeaders,
                buildToolUsage(responsePromptTokens, prepared.toolCalls),
                responsePromptTokens,
                glmStats,
                "raw",
                toolRegistry,
                {
                  ...rawDispatchContext,
                  rawSignature: prepared.signature,
                },
                lastModelThinking,
              );
            }
            if (PROXY_DEBUG) {
              console.log("proxy_debug raw_tool_calls_suppressed: true");
            }
          }
          if (PROXY_DEBUG) {
            console.log("proxy_debug raw_tool_calls_blocked: true");
          }
        }
        return sendStreamContent(
          reply,
          fullText,
          model,
          glmStats,
          responsePromptTokens,
          lastModelThinking,
        );
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
    const content = await collectModelResponse(activeChatId, glmMessages);
    if (tools.length > 0) {
      const rawToolCalls = parseRawToolCalls(content, toolRegistry);
      if (rawToolCalls && isRawToolCallsAllowed(rawToolCalls)) {
        const prepared = prepareRawToolCalls(rawToolCalls, rawDispatchContext, toolRegistry);
        if (prepared) {
          return guardAndSendToolCalls(
            reply,
            prepared.toolCalls,
            model,
            false,
            {},
            buildToolUsage(responsePromptTokens, prepared.toolCalls),
            responsePromptTokens,
            glmStats,
            "raw",
            toolRegistry,
            {
              ...rawDispatchContext,
              rawSignature: prepared.signature,
            },
            lastModelThinking,
          );
        }
      }
    }
    return sendContent(reply, content, model, responsePromptTokens, glmStats);
  };

  return handleChatCompletion;
};

export { createChatCompletionHandler };

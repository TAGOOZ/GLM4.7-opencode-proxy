import type { FastifyRequest } from "fastify";
import { debugDump, writeDebugDump } from "../debug.js";
import {
  DEFAULT_MODEL,
  PROXY_ALLOW_USER_HEURISTICS,
  PROXY_ALLOW_WEB_SEARCH,
  PROXY_DEBUG,
  PROXY_DEFAULT_THINKING,
  PROXY_STRIP_HISTORY,
  PROXY_TEST_MODE,
  PROXY_TOOL_LOOP_LIMIT,
} from "../constants.js";
import { stripDirectivesFromContent } from "../messages.js";
import { extractContentText } from "./utils.js";
import { extractTestDirectives, previewMessage } from "./messageHelpers.js";
import {
  inferExplicitToolCalls,
  inferListToolCall,
  inferReadToolCall,
  inferSearchToolCall,
} from "../tools/infer.js";
import { buildToolRegistry, isNetworkTool, type ToolInfo } from "../tools/registry.js";
import { filterPlannerTools, shouldAllowTodoTools } from "../tools/policy.js";
import { inferRecentFilePath } from "../tools/path.js";
import type { RawDispatchContext } from "./rawToolCalls.js";
import { EMBEDDED_READ_REGEX } from "../constants.js";

export type PreparedChatRequest = {
  body: any;
  model: string;
  messages: any[];
  rawTools: any[];
  stream: boolean;
  toolChoice: any;
  tools: any[];
  toolRegistry: Map<string, ToolInfo>;
  sanitizedMessages: any[];
  lastUser: string;
  hasToolResult: boolean;
  toolResultCount: number;
  maxToolLoops: number;
  allowTodoWrite: boolean;
  featureOverrides: Record<string, unknown>;
  enableThinkingFinal: boolean;
  rawDispatchContext: RawDispatchContext;
  allowHeuristicTools: boolean;
  explicitToolCalls: any[] | null;
  inferredToolCall: any[] | null;
  shouldAttemptTools: boolean;
  toolChoiceRequired: boolean;
  systemText: string;
};

export const prepareChatRequest = async (
  request: FastifyRequest,
  requestId: string,
): Promise<PreparedChatRequest> => {
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
  const rawDispatchContext: RawDispatchContext = {
    lastUser,
    hasToolResult,
    allowTodoWrite,
    recentFilePath: inferRecentFilePath(sanitizedMessages),
  };
  const hasEmbeddedRead = EMBEDDED_READ_REGEX.test(lastUser);
  const disableHeuristics = PROXY_TEST_MODE && testDirectives.disableHeuristics;

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

  return {
    body,
    model,
    messages,
    rawTools,
    stream,
    toolChoice,
    tools,
    toolRegistry,
    sanitizedMessages,
    lastUser,
    hasToolResult,
    toolResultCount,
    maxToolLoops,
    allowTodoWrite,
    featureOverrides,
    enableThinkingFinal,
    rawDispatchContext,
    allowHeuristicTools,
    explicitToolCalls,
    inferredToolCall,
    shouldAttemptTools,
    toolChoiceRequired,
    systemText,
  };
};

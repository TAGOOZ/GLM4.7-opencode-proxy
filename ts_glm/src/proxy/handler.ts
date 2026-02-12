import crypto from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { GLMClient } from "../glmClient.js";
import { debugLog, traceAsync, traceSpanStart, traceSync } from "./debug.js";
import {
  PROXY_ALWAYS_SEND_SYSTEM,
  PROXY_COMPACT_RESET,
  PROXY_DEBUG,
  PROXY_HISTORY_MAX_MESSAGES,
  PROXY_INCLUDE_HISTORY_IN_REQUEST,
  PROXY_USE_GLM_HISTORY,
} from "./constants.js";
import { compactMessages, estimateMessagesTokens, getContextConfig } from "./context.js";
import { collectGlmResponseDetailed, convertMessages } from "./messages.js";
import { buildSignature, buildStreamHeaders, computeDeltaMessages } from "./handler/utils.js";
import { buildMessages } from "./handler/messageHelpers.js";
import { createHandlerFlows } from "./handler/flows.js";
import { sendContent, sendStreamContent } from "./handler/responseHelpers.js";
import { createToolDispatch, type RawDispatchState } from "./handler/dispatch.js";
import { createPromptTelemetryTracker } from "./handler/promptTelemetry.js";
import { prepareChatRequest } from "./handler/request.js";

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
  const rawDispatchState: RawDispatchState = { signature: "", user: "" };
  const POST_TOOL_SYSTEM = [
    "You have received tool results.",
    "Return ONLY one JSON object matching the planner schema keys: plan, actions, final.",
    "If more tools are needed: include actions and omit final.",
    "If no further tools are needed: actions must be empty and final must be a string.",
    "No markdown and no extra prose.",
  ].join(" ");
  const toText = (content: any): string => {
    if (typeof content === "string") return content;
    try {
      return JSON.stringify(content ?? "");
    } catch {
      return String(content ?? "");
    }
  };
  const clip = (value: string, max: number): string => {
    const text = String(value || "");
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  const POST_TOOL_STATE_WINDOW = 6;
  const formatAssistantToolAction = (msg: any): string => {
    const text = toText(msg?.content).trim();
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    if (toolCalls.length > 0) {
      const summarized = toolCalls.map((tc: any) => ({
        id: tc?.id ?? null,
        name: tc?.function?.name ?? tc?.name ?? null,
        arguments: tc?.function?.arguments ?? tc?.arguments ?? null,
      }));
      const toolCallsText = toText(summarized);
      return text ? `${text}\nTOOL_CALLS:\n${toolCallsText}` : `TOOL_CALLS:\n${toolCallsText}`;
    }
    return text;
  };
  const isAssistantActionMessage = (msg: any): boolean => {
    if (msg?.role !== "assistant") return false;
    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) return true;
    const text = toText(msg?.content).trimStart();
    return text.startsWith("[{") || text.startsWith("{\"actions\"");
  };
  const buildMinimalPostToolMessages = (sourceMessages: any[]): { role: string; content: string }[] => {
    const lastUser = [...sourceMessages].reverse().find((msg: any) => msg?.role === "user");
    const recentAssistantActions = sourceMessages.filter(isAssistantActionMessage).slice(-POST_TOOL_STATE_WINDOW);
    const recentToolResults = sourceMessages
      .filter((msg: any) => msg?.role === "tool" || msg?.tool_call_id)
      .slice(-POST_TOOL_STATE_WINDOW);
    const lastAssistantAction = recentAssistantActions[recentAssistantActions.length - 1];
    const lastTool = recentToolResults[recentToolResults.length - 1];
    const out: { role: string; content: string }[] = [{ role: "system", content: POST_TOOL_SYSTEM }];
    if (lastUser) {
      out.push({
        role: "user",
        content: `LAST_USER_REQUEST:\n${clip(toText(lastUser.content), 1200)}`,
      });
    }
    if (lastAssistantAction) {
      out.push({
        role: "assistant",
        content: `LAST_ASSISTANT_TOOL_ACTION:\n${clip(formatAssistantToolAction(lastAssistantAction), 2600)}`,
      });
    }
    if (lastTool) {
      out.push({
        role: "user",
        content: `LATEST_TOOL_RESULT:\n${clip(toText(lastTool.content), 3600)}`,
      });
    }
    if (recentAssistantActions.length > 0 || recentToolResults.length > 0) {
      const executionTimeline = sourceMessages
        .filter((msg: any) => isAssistantActionMessage(msg) || msg?.role === "tool" || msg?.tool_call_id)
        .slice(-(POST_TOOL_STATE_WINDOW * 2))
        .map((msg: any) => {
          if (isAssistantActionMessage(msg)) {
            return `ASSISTANT_ACTION:\n${clip(formatAssistantToolAction(msg), 1200)}`;
          }
          return `TOOL_RESULT:\n${clip(toText(msg?.content), 1200)}`;
        })
        .join("\n\n");
      out.push({
        role: "user",
        content: `RECENT_EXECUTION_STATE (last ${POST_TOOL_STATE_WINDOW} actions/results):\n${executionTimeline}`,
      });
    }
    return out;
  };
  const { guardAndSendToolCalls, tryHandlePendingConfirmation } = createToolDispatch({
    rawDispatchState,
  });
  let lastShouldAttemptTools = false;

  const { handlePlannerFlow, handleStreamNoTools, handleNonStreamNoTools } = createHandlerFlows({
    client,
    contextConfig,
    postToolSystem: POST_TOOL_SYSTEM,
    guardAndSendToolCalls,
    sendContent,
    sendStreamContent,
  });

  const handleChatCompletion = async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    reply.header("x-proxy-request-id", requestId);
    const endRequestTrace = traceSpanStart("request_total", { requestId });
    const promptTelemetry = createPromptTelemetryTracker();
    try {
    const confirmHandled = tryHandlePendingConfirmation(request, reply);
    if (confirmHandled.handled) return;
    const prepared = await traceAsync(
      "prepare_chat_request",
      () => prepareChatRequest(request, requestId),
      { requestId },
    );
    const {
      model,
      messages,
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
      toolChoiceFunctionName,
      toolChoiceUnknownFunction,
      confirmationScope,
      systemText,
    } = prepared;
    if (toolChoiceUnknownFunction) {
      const content = `Unknown tool in tool_choice: ${toolChoiceUnknownFunction}`;
      if (stream) {
        return sendStreamContent(reply, content, model);
      }
      return sendContent(reply, content, model, 0);
    }
    let chatId: string | null = null;
    const getChatId = async () => {
      if (!chatId) {
        chatId = await ensureChat();
        debugLog("request", requestId, "active_chat_id:", chatId);
      }
      return chatId;
    };
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
        const toolPreview = toolMsg?.content ? toolMsg.content.slice(0, 200) : "";
        console.log("proxy_debug tool_result_preview:", toolPreview);
      }
    }
    const runtimeWorkspaceSystem = [
      "Runtime workspace context:",
      "- The proxy cwd may differ from the OpenCode tool runtime cwd.",
      "- Prefer user-workspace relative paths unless an absolute workspace path is required.",
    ].join("\n");
    const plannerSystemText = [systemText, runtimeWorkspaceSystem].filter(Boolean).join("\n\n");
    const baseMessages = traceSync(
      "build_base_messages",
      () =>
        buildMessages(
          contextConfig,
          sanitizedMessages,
          shouldAttemptTools ? tools : [],
          shouldAttemptTools ? plannerSystemText : systemText,
        ),
      {
        requestId,
        sanitizedMessageCount: sanitizedMessages.length,
        toolCount: shouldAttemptTools ? tools.length : 0,
      },
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
        lastShouldAttemptTools = false;
      }
      if (PROXY_DEBUG) {
        console.log("proxy_debug compaction_reset: true");
      }
    }
    const useHistoryThisRequest = useGlmHistory && !compactionReset;
    let historyToolPromptReseeded = false;
    if (useHistoryThisRequest) {
      const signature = buildSignature(tools, plannerSystemText || systemText);
      const signatureChanged = signature !== lastSignature;
      const modeFlipRequiresReseed = shouldAttemptTools && !lastShouldAttemptTools;
      const deltaResult = traceSync(
        "history_compute_delta",
        () => computeDeltaMessages(sanitizedMessages, lastMessages),
        {
          requestId,
          currentMessages: sanitizedMessages.length,
          previousMessages: lastMessages.length,
        },
      );
      if (deltaResult.reset || signatureChanged) {
        resetChat();
        chatId = null;
        lastMessages = [];
        lastShouldAttemptTools = false;
      }
      const reseed = deltaResult.reseed || signatureChanged || lastMessages.length === 0 || modeFlipRequiresReseed;
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
      historyToolPromptReseeded = shouldAttemptTools && reseed;
      const toolSeed = historyToolPromptReseeded ? tools : [];
      const extraSystem = historyToolPromptReseeded ? plannerSystemText : "";
      const deltaConverted = traceSync(
        "history_convert_messages",
        () =>
          convertMessages(injectedDeltaMessages, toolSeed, {
            toolMaxLines: contextConfig.toolMaxLines,
            toolMaxChars: contextConfig.toolMaxChars,
            extraSystem,
          }),
        {
          requestId,
          deltaMessageCount: injectedDeltaMessages.length,
          toolSeedCount: toolSeed.length,
        },
      );
      const compacted = traceSync(
        "history_compact_messages",
        () => compactMessages(deltaConverted, contextConfig),
        {
          requestId,
          convertedCount: deltaConverted.length,
        },
      );
      const includeHistoryInRequest = PROXY_INCLUDE_HISTORY_IN_REQUEST && useHistoryThisRequest;
      if (compacted.messages.length === 0 && !includeHistoryInRequest) {
        // Never send an empty request when we are not asking GLM to include chat history.
        // Fall back to full base messages for this turn.
        glmMessages = baseMessages.messages;
        glmStats = baseMessages.stats;
        if (PROXY_DEBUG) {
          console.log("proxy_debug empty_delta_fallback_to_base_messages: true");
        }
      } else {
        glmMessages = compacted.messages;
        glmStats = baseMessages.stats;
      }
      lastMessages =
        PROXY_HISTORY_MAX_MESSAGES > 0
          ? sanitizedMessages.slice(-PROXY_HISTORY_MAX_MESSAGES)
          : sanitizedMessages;
      lastSignature = signature;
      lastShouldAttemptTools = shouldAttemptTools;
    } else if (useGlmHistory) {
      lastMessages =
        PROXY_HISTORY_MAX_MESSAGES > 0
          ? sanitizedMessages.slice(-PROXY_HISTORY_MAX_MESSAGES)
          : sanitizedMessages;
      lastSignature = buildSignature(tools, plannerSystemText || systemText);
      lastShouldAttemptTools = shouldAttemptTools;
    }
    if (hasToolResult && shouldAttemptTools) {
      const minimalMessages = buildMinimalPostToolMessages(sanitizedMessages);
      const convertedMinimal = convertMessages(minimalMessages, tools, {
        toolMaxLines: contextConfig.toolMaxLines,
        toolMaxChars: contextConfig.toolMaxChars,
        extraSystem: plannerSystemText,
      });
      const withInstruction = traceSync(
        "post_tool_compact_messages",
        () => compactMessages(convertedMinimal, contextConfig),
        {
          requestId,
          instructedCount: convertedMinimal.length,
        },
      );
      glmMessages = withInstruction.messages;
      glmStats = withInstruction.stats;
    }
    let responsePromptTokens = estimateMessagesTokens(glmMessages);
    const streamHeaders = buildStreamHeaders(glmStats);
    const thinkingRef = { value: "" };
    const collectModelResponse = async (
      chatId: string,
      requestMessages: { role: string; content: string }[],
      options?: { parentMessageId?: string | null },
    ) => {
      const promptStats = promptTelemetry.record(requestMessages);
      if (PROXY_DEBUG) {
        debugLog("request", requestId, "prompt_stats", {
          call: promptStats.collect_call_index,
          prompt_chars: promptStats.prompt_chars,
          system_chars: promptStats.system_chars,
          history_chars: promptStats.history_chars,
          prompt_chars_delta_prev: promptStats.prompt_chars_delta_prev,
          prompt_chars_delta_first: promptStats.prompt_chars_delta_first,
          tool_count: shouldAttemptTools ? tools.length : 0,
        });
      }
      return traceAsync(
        "glm_collect_response",
        async () => {
          const detailed = await collectGlmResponseDetailed(client, chatId, requestMessages, {
            enableThinking: enableThinkingFinal,
            features: featureOverrides,
            includeHistory: PROXY_INCLUDE_HISTORY_IN_REQUEST && useHistoryThisRequest,
            parentMessageId: options?.parentMessageId,
          });
          thinkingRef.value = detailed.thinking;
          return detailed.content;
        },
        {
          requestId,
          chatId,
          messageCount: requestMessages.length,
          prompt_chars: promptStats.prompt_chars,
          system_chars: promptStats.system_chars,
          history_chars: promptStats.history_chars,
          prompt_chars_delta_prev: promptStats.prompt_chars_delta_prev,
          prompt_chars_delta_first: promptStats.prompt_chars_delta_first,
          collect_call_index: promptStats.collect_call_index,
          tool_count: shouldAttemptTools ? tools.length : 0,
          includeHistory: PROXY_INCLUDE_HISTORY_IN_REQUEST && useHistoryThisRequest,
          enableThinking: enableThinkingFinal,
          parentMessageId: options?.parentMessageId ?? "[auto]",
        },
      );
    };

    if (shouldAttemptTools) {
      return await handlePlannerFlow({
        reply,
        model,
        stream,
        streamHeaders,
        toolRegistry,
        rawDispatchContext,
        lastRawDispatchSignature: rawDispatchState.signature,
        lastRawDispatchUser: rawDispatchState.user,
        lastUser,
        allowHeuristicTools,
        explicitToolCalls,
        inferredToolCall,
        toolChoiceRequired,
        toolChoiceFunctionName,
        confirmationScope,
        tools,
        messages,
        sanitizedMessages,
        hasToolResult,
        toolResultCount,
        maxToolLoops,
        allowTodoWrite,
        useHistoryThisRequest,
        glmMessages,
        glmStats,
        responsePromptTokens,
        collectModelResponse,
        getChatId,
        thinkingRef,
      });
    }

    if (stream) {
      return await handleStreamNoTools({
        reply,
        model,
        tools,
        glmMessages,
        glmStats,
        responsePromptTokens,
        streamHeaders,
        toolRegistry,
        rawDispatchContext,
        lastRawDispatchSignature: rawDispatchState.signature,
        lastRawDispatchUser: rawDispatchState.user,
        collectModelResponse,
        getChatId,
        useHistoryThisRequest,
        enableThinkingFinal,
        featureOverrides,
        thinkingRef,
        toolChoiceFunctionName,
        confirmationScope,
      });
    }

    return await handleNonStreamNoTools({
      reply,
      model,
      tools,
      glmMessages,
      glmStats,
      responsePromptTokens,
      toolRegistry,
      rawDispatchContext,
      lastRawDispatchSignature: rawDispatchState.signature,
      lastRawDispatchUser: rawDispatchState.user,
      collectModelResponse,
      getChatId,
      thinkingRef,
      toolChoiceFunctionName,
      confirmationScope,
    });
    } finally {
      const promptSummary = promptTelemetry.summary();
      endRequestTrace(promptSummary || { collect_calls: 0 });
    }
  };

  return handleChatCompletion;
};

export { createChatCompletionHandler };

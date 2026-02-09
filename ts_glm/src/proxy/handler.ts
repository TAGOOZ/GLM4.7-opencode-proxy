import crypto from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { GLMClient } from "../glmClient.js";
import { debugLog, traceAsync, traceSpanStart, traceSync } from "./debug.js";
import {
  PROXY_ALWAYS_SEND_SYSTEM,
  PROXY_COMPACT_RESET,
  PROXY_DEBUG,
  PROXY_HISTORY_MAX_MESSAGES,
  PROXY_USE_GLM_HISTORY,
} from "./constants.js";
import { compactMessages, estimateMessagesTokens, getContextConfig } from "./context.js";
import { collectGlmResponseDetailed, convertMessages } from "./messages.js";
import { buildSignature, buildStreamHeaders, computeDeltaMessages } from "./handler/utils.js";
import { buildInstructionMessages, buildMessages } from "./handler/messageHelpers.js";
import { createHandlerFlows } from "./handler/flows.js";
import { sendContent, sendStreamContent } from "./handler/responseHelpers.js";
import { createToolDispatch, type RawDispatchState } from "./handler/dispatch.js";
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
    "Continue the task.",
    "If more tools are needed, return ONLY a JSON object matching the schema with actions.",
    "If no further tools are needed, return ONLY a JSON object matching the schema with actions empty and include final.",
    "No extra text or analysis.",
  ].join(" ");
  const { guardAndSendToolCalls, tryHandlePendingConfirmation } = createToolDispatch({
    rawDispatchState,
  });

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
      `- cwd: ${process.cwd()}`,
      "Path policy: use repo-relative paths for tool args whenever possible.",
      "Prefer explicit file paths for read/write/edit/apply_patch; if unknown, inspect with path '.' first.",
      "For apply_patch/patch, include explicit target file headers when available (*** Update File: ... or diff --git ...).",
      "Avoid absolute paths, ~, and ../ traversal in tool args.",
      "Use the tool schema's exact path key (path/filePath/file_path).",
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
    if (hasToolResult && shouldAttemptTools) {
      if (useHistoryThisRequest) {
        const toolSeed = tools;
        const instructedMessages = convertMessages(sanitizedMessages, toolSeed, {
          toolMaxLines: contextConfig.toolMaxLines,
          toolMaxChars: contextConfig.toolMaxChars,
          extraSystem: plannerSystemText,
        });
        const withInstruction = traceSync(
          "post_tool_compact_messages",
          () =>
            compactMessages(
              [
                {
                  role: "system",
                  content: POST_TOOL_SYSTEM,
                },
                ...instructedMessages,
              ],
              contextConfig,
            ),
          {
            requestId,
            instructedCount: instructedMessages.length,
          },
        );
        glmMessages = withInstruction.messages;
        glmStats = withInstruction.stats;
      } else {
        const instructed = buildInstructionMessages(
          contextConfig,
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
    const thinkingRef = { value: "" };
    const collectModelResponse = async (
      chatId: string,
      requestMessages: { role: string; content: string }[],
      options?: { parentMessageId?: string | null },
    ) =>
      traceAsync(
        "glm_collect_response",
        async () => {
          const detailed = await collectGlmResponseDetailed(client, chatId, requestMessages, {
            enableThinking: enableThinkingFinal,
            features: featureOverrides,
            includeHistory: useHistoryThisRequest,
            parentMessageId: options?.parentMessageId,
          });
          thinkingRef.value = detailed.thinking;
          return detailed.content;
        },
        {
          requestId,
          chatId,
          messageCount: requestMessages.length,
          includeHistory: useHistoryThisRequest,
          enableThinking: enableThinkingFinal,
          parentMessageId: options?.parentMessageId ?? "[auto]",
        },
      );

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
      endRequestTrace();
    }
  };

  return handleChatCompletion;
};

export { createChatCompletionHandler };

import crypto from "crypto";
import { PROXY_INCLUDE_USAGE } from "../constants.js";
import { parseRawToolCalls } from "../tools/parse.js";
import { buildUsage } from "./utils.js";
import { tryDispatchRawToolCalls } from "./rawDispatchFlow.js";
import type {
  FallbackFlowDeps,
  NonStreamFallbackContext,
  StreamFallbackContext,
} from "./flowTypes.js";

export const createFallbackFlows = (deps: FallbackFlowDeps) => {
  const handleStreamNoTools = async (ctx: StreamFallbackContext) => {
    const {
      reply,
      model,
      tools,
      glmMessages,
      glmStats,
      responsePromptTokens,
      streamHeaders,
      toolRegistry,
      rawDispatchContext,
      lastRawDispatchSignature,
      lastRawDispatchUser,
      collectModelResponse,
      getChatId,
      useHistoryThisRequest,
      enableThinkingFinal,
      featureOverrides,
      thinkingRef,
      toolChoiceFunctionName,
      confirmationScope,
    } = ctx;
    const activeChatId = await getChatId();
    if (tools.length > 0) {
      const fullText = await collectModelResponse(activeChatId, glmMessages);
      const rawDispatch = tryDispatchRawToolCalls({
        rawToolCalls: parseRawToolCalls(fullText, toolRegistry, {
          allowProseEnvelope: false,
        }),
        reply,
        model,
        stream: true,
        streamHeaders,
        promptTokens: responsePromptTokens,
        stats: glmStats,
        toolRegistry,
        rawDispatchContext,
        lastRawDispatchSignature,
        lastRawDispatchUser,
        guardAndSendToolCalls: deps.guardAndSendToolCalls,
        reasoningContent: thinkingRef.value,
        requiredToolName: toolChoiceFunctionName,
        confirmationScope,
      });
      if (rawDispatch) {
        return rawDispatch;
      }
      return deps.sendStreamContent(
        reply,
        fullText,
        model,
        glmStats,
        responsePromptTokens,
        thinkingRef.value,
      );
    }
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", ...streamHeaders });
    let parentId: string | null = null;
    try {
      parentId = await deps.client.getCurrentMessageId(activeChatId);
    } catch {
      parentId = null;
    }
    const generator = deps.client.sendMessage({
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
  };

  const handleNonStreamNoTools = async (ctx: NonStreamFallbackContext) => {
    const {
      reply,
      model,
      tools,
      glmMessages,
      glmStats,
      responsePromptTokens,
      toolRegistry,
      rawDispatchContext,
      lastRawDispatchSignature,
      lastRawDispatchUser,
      collectModelResponse,
      getChatId,
      thinkingRef,
      toolChoiceFunctionName,
      confirmationScope,
    } = ctx;
    const activeChatId = await getChatId();
    const content = await collectModelResponse(activeChatId, glmMessages);
    if (tools.length > 0) {
      const rawDispatch = tryDispatchRawToolCalls({
        rawToolCalls: parseRawToolCalls(content, toolRegistry, {
          allowProseEnvelope: false,
        }),
        reply,
        model,
        stream: false,
        streamHeaders: {},
        promptTokens: responsePromptTokens,
        stats: glmStats,
        toolRegistry,
        rawDispatchContext,
        lastRawDispatchSignature,
        lastRawDispatchUser,
        guardAndSendToolCalls: deps.guardAndSendToolCalls,
        reasoningContent: thinkingRef.value,
        requiredToolName: toolChoiceFunctionName,
        confirmationScope,
      });
      if (rawDispatch) {
        return rawDispatch;
      }
    }
    return deps.sendContent(reply, content, model, responsePromptTokens, glmStats);
  };

  return { handleStreamNoTools, handleNonStreamNoTools };
};

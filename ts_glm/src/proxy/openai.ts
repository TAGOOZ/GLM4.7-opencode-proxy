import crypto from "crypto";
import type { FastifyReply } from "fastify";
import { PROXY_DEBUG } from "./constants.js";
import { debugDump, truncate } from "./debug.js";

// Some OpenAI-compatible clients are strict about the non-stream tool_calls shape.
// In non-stream responses, tool_calls entries should not include "index".
const sanitizeNonStreamToolCalls = (toolCalls: any[]) => {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((call) => {
    const { id, type, function: fn } = call || {};
    const out: any = {};
    if (id != null) out.id = id;
    out.type = type || "function";
    out.function = fn || {};
    return out;
  });
};

const createCompletionBase = (model: string) => ({
  id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
});

const createStreamMeta = (model: string) => ({
  id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
  created: Math.floor(Date.now() / 1000),
  model,
});

const openaiToolResponse = (toolCalls: any[], model: string, usage?: Record<string, number>) => ({
  ...createCompletionBase(model),
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: null, tool_calls: sanitizeNonStreamToolCalls(toolCalls) },
      finish_reason: "tool_calls",
    },
  ],
  ...(usage ? { usage } : {}),
});

const openaiContentResponse = (content: string, model: string, usage?: Record<string, number>) => ({
  ...createCompletionBase(model),
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
  ...(usage ? { usage } : {}),
});

const appendReasoningChunk = (
  chunks: string[],
  meta: { id: string; created: number; model: string },
  reasoningContent?: string,
) => {
  const trimmedReasoning = String(reasoningContent || "").trim();
  if (!trimmedReasoning) return;
  chunks.push(
    `data: ${JSON.stringify({
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta: { reasoning_content: trimmedReasoning }, finish_reason: null }],
    })}\n\n`,
  );
};

const appendFinalStreamChunk = (
  chunks: string[],
  meta: { id: string; created: number; model: string },
  finishReason: "stop" | "tool_calls",
  usage?: Record<string, number>,
) => {
  const finalChunk: Record<string, unknown> = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  if (usage) {
    finalChunk.usage = usage;
  }
  chunks.push(`data: ${JSON.stringify(finalChunk)}\n\n`);
  chunks.push("data: [DONE]\n\n");
};

const streamAssistantDelta = (params: {
  model: string;
  delta: Record<string, unknown>;
  finishReason: "stop" | "tool_calls";
  usage?: Record<string, number>;
  reasoningContent?: string;
}) => {
  const { model, delta, finishReason, usage, reasoningContent } = params;
  const meta = createStreamMeta(model);
  const chunks: string[] = [];
  appendReasoningChunk(chunks, meta, reasoningContent);
  chunks.push(
    `data: ${JSON.stringify({
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`,
  );
  appendFinalStreamChunk(chunks, meta, finishReason, usage);
  return chunks.join("");
};

const streamContent = (
  content: string,
  model: string,
  usage?: Record<string, number>,
  reasoningContent?: string,
) =>
  streamAssistantDelta({
    model,
    delta: { role: "assistant", content },
    finishReason: "stop",
    usage,
    reasoningContent,
  });

const streamToolCalls = (
  toolCalls: any[],
  model: string,
  usage?: Record<string, number>,
  reasoningContent?: string,
) =>
  // Usage on streamed tool_calls isn't consistently supported; keep it in the final chunk only.
  streamAssistantDelta({
    model,
    delta: { role: "assistant", tool_calls: toolCalls },
    finishReason: "tool_calls",
    usage,
    reasoningContent,
  });

const sendToolCalls = (
  reply: FastifyReply,
  toolCalls: any[],
  model: string,
  stream: boolean,
  headers?: Record<string, string>,
  usage?: Record<string, number>,
  reasoningContent?: string,
) => {
  if (PROXY_DEBUG) {
    const summary = (Array.isArray(toolCalls) ? toolCalls : []).map((c: any) => ({
      id: c?.id,
      type: c?.type,
      name: c?.function?.name,
      argsPreview:
        typeof c?.function?.arguments === "string"
          ? truncate(c.function.arguments, 400)
          : undefined,
    }));
    debugDump("sendToolCalls", {
      model,
      stream,
      count: Array.isArray(toolCalls) ? toolCalls.length : 0,
      toolCalls: summary,
    });
  }
  if (stream) {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", ...(headers || {}) });
    reply.raw.write(streamToolCalls(toolCalls, model, usage, reasoningContent));
    return reply.raw.end();
  }
  return reply.send(openaiToolResponse(toolCalls, model, usage));
};

export {
  openaiContentResponse,
  openaiToolResponse,
  sendToolCalls,
  streamContent,
  streamToolCalls,
};

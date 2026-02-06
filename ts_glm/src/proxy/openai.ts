import crypto from "crypto";
import type { FastifyReply } from "fastify";

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

const openaiToolResponse = (toolCalls: any[], model: string, usage?: Record<string, number>) => ({
  id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
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
  id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
  ...(usage ? { usage } : {}),
});

const streamContent = (content: string, model: string, usage?: Record<string, number>) => {
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const finalChunk: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  if (usage) {
    finalChunk.usage = usage;
  }
  return [
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify(finalChunk)}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
};

const streamToolCalls = (toolCalls: any[], model: string, usage?: Record<string, number>) => {
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const firstChunk: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null }],
  };
  const finalChunk: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
  // Usage on streamed tool_calls isn't consistently supported; keep it in the final chunk only.
  if (usage) finalChunk.usage = usage;
  return [
    `data: ${JSON.stringify(firstChunk)}\n\n`,
    `data: ${JSON.stringify(finalChunk)}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
};

const sendToolCalls = (
  reply: FastifyReply,
  toolCalls: any[],
  model: string,
  stream: boolean,
  headers?: Record<string, string>,
  usage?: Record<string, number>,
) => {
  if (stream) {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", ...(headers || {}) });
    reply.raw.write(streamToolCalls(toolCalls, model, usage));
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

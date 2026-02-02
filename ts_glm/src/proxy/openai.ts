import crypto from "crypto";
import type { FastifyReply } from "fastify";

const openaiToolResponse = (toolCalls: any[], model: string) => ({
  id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: null, tool_calls: toolCalls },
      finish_reason: "tool_calls",
    },
  ],
});

const openaiContentResponse = (content: string, model: string) => ({
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
});

const streamContent = (content: string, model: string) => {
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  return [
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
};

const streamToolCalls = (toolCalls: any[], model: string) => {
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  return [
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: "tool_calls" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
};

const sendToolCalls = (reply: FastifyReply, toolCalls: any[], model: string, stream: boolean) => {
  if (stream) {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.raw.write(streamToolCalls(toolCalls, model));
    return reply.raw.end();
  }
  return reply.send(openaiToolResponse(toolCalls, model));
};

export {
  openaiContentResponse,
  openaiToolResponse,
  sendToolCalls,
  streamContent,
  streamToolCalls,
};

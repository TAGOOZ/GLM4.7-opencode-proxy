import type { FastifyReply } from "fastify";
import type { ContextStats } from "../context.js";
import { debugDump, truncate } from "../debug.js";
import { openaiContentResponse, streamContent } from "../openai.js";
import { applyResponseHeaders, buildStreamHeaders, buildUsage } from "./utils.js";

export const sendStreamContent = (
  reply: FastifyReply,
  content: string,
  model: string,
  stats?: ContextStats,
  promptTokens?: number,
  reasoningContent?: string,
) => {
  const headers = buildStreamHeaders(stats);
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", ...headers });
  const usage = promptTokens !== undefined ? buildUsage(promptTokens, content) : undefined;
  reply.raw.write(streamContent(content, model, usage, reasoningContent));
  return reply.raw.end();
};

export const sendContent = (
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

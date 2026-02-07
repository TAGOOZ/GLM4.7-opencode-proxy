import type { FastifyReply, FastifyRequest } from "fastify";
import type { ContextStats } from "../context.js";
import { DEFAULT_MODEL, PROXY_DEBUG, PROXY_MAX_ACTIONS_PER_TURN } from "../constants.js";
import { debugDump, truncate } from "../debug.js";
import { openaiContentResponse, sendToolCalls, streamContent } from "../openai.js";
import { validateToolCalls } from "./guards.js";
import { applyResponseHeaders, buildToolUsage, isAffirmativeConfirmation } from "./utils.js";
import { sendContent, sendStreamContent } from "./responseHelpers.js";
import type { RawDispatchContext } from "./rawToolCalls.js";
import type { ToolInfo } from "../tools/registry.js";

export type RawDispatchState = { signature: string; user: string };

type GuardAndSendToolCalls = (
  reply: FastifyReply,
  toolCalls: any[],
  model: string,
  stream: boolean,
  headers: Record<string, string>,
  usage: Record<string, number> | undefined,
  promptTokens: number,
  stats?: ContextStats,
  source?: "planner" | "raw" | "heuristic" | "explicit",
  registry?: Map<string, ToolInfo>,
  rawContext?: RawDispatchContext & { rawSignature?: string },
  reasoningContent?: string,
) => unknown;

export const createToolDispatch = (deps: { rawDispatchState: RawDispatchState }) => {
  const pendingConfirmations = new Map<
    string,
    { toolCalls: any[]; blockedReason: string; createdAt: number }
  >();
  const PENDING_CONFIRM_TTL_MS = 10 * 60 * 1000;

  const guardAndSendToolCalls: GuardAndSendToolCalls = (
    reply,
    toolCalls,
    model,
    stream,
    headers,
    usage,
    promptTokens,
    stats,
    source = "planner",
    registry,
    rawContext,
    reasoningContent,
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
      deps.rawDispatchState.signature = rawContext.rawSignature;
      deps.rawDispatchState.user = rawContext.lastUser;
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

  return { guardAndSendToolCalls, tryHandlePendingConfirmation };
};

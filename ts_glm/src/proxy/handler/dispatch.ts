import type { FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MODEL, PROXY_DEBUG, PROXY_STAGE_FILE_MUTATIONS } from "../constants.js";
import { debugDump, traceSync, truncate } from "../debug.js";
import { openaiContentResponse, sendToolCalls, streamContent } from "../openai.js";
import { parseRawJson } from "../tools/parseJson.js";
import { findTool } from "../tools/registry.js";
import { validateToolCalls } from "./guards.js";
import { applyResponseHeaders, buildToolUsage, isAffirmativeConfirmation } from "./utils.js";
import { sendContent, sendStreamContent } from "./responseHelpers.js";
import type { GuardAndSendToolCalls } from "./flowTypes.js";

export type RawDispatchState = { signature: string; user: string };

export const createToolDispatch = (deps: { rawDispatchState: RawDispatchState }) => {
  const extractLatestUserText = (messages: any[]): string => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role !== "user") continue;
      const content = messages[i]?.content;
      if (typeof content === "string") return content.trim();
      try {
        return JSON.stringify(content ?? "");
      } catch {
        return String(content ?? "");
      }
    }
    return "";
  };

  const normalizeUserIntent = (input: string): string => {
    const stopwords = new Set([
      "the",
      "a",
      "an",
      "to",
      "for",
      "of",
      "on",
      "in",
      "with",
      "and",
      "or",
      "it",
      "this",
      "that",
      "please",
      "now",
      "then",
      "just",
    ]);
    const cleaned = String(input || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ");
    const tokens = cleaned
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stopwords.has(token));
    if (!tokens.length) return "";
    const uniqueSorted = [...new Set(tokens)].sort();
    return uniqueSorted.slice(0, 12).join(" ");
  };

  const pendingConfirmations = new Map<
    string,
    { toolCalls: any[]; blockedReason: string; createdAt: number; scope: string }
  >();
  const pendingStagedMutations = new Map<
    string,
    { toolCalls: any[]; createdAt: number; targetPath: string; reason: string }
  >();
  const PENDING_CONFIRM_TTL_MS = 10 * 60 * 1000;
  const DEFAULT_SCOPE = "global";

  const resolveExistingFile = (rawPath: string): { absPath: string; size: number } | null => {
    const trimmed = String(rawPath || "").trim();
    if (!trimmed) return null;
    const candidates: string[] = [];
    if (path.isAbsolute(trimmed)) {
      candidates.push(path.resolve(trimmed));
    } else {
      candidates.push(path.resolve(process.cwd(), trimmed));
    }
    for (const abs of candidates) {
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        return { absPath: abs, size: st.size };
      } catch {
        // ignore
      }
    }
    return null;
  };

  const maybeStageFileMutation = (params: {
    reply: FastifyReply;
    toolCalls: any[];
    model: string;
    stream: boolean;
    headers?: Record<string, string>;
    usage?: Record<string, number>;
    promptTokens: number;
    stats: any;
    registry: Map<string, any>;
    confirmationScope: string;
    reasoningContent?: string;
  }): { staged: boolean } => {
    if (!PROXY_STAGE_FILE_MUTATIONS) return { staged: false };
    const { reply, toolCalls, model, stream, headers, promptTokens, stats, registry, confirmationScope, reasoningContent } =
      params;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return { staged: false };

    const mutationTools = new Set(["write", "writefile", "edit", "editfile", "applypatch", "patch"]);
    let targetPath = "";
    let reason = "";
    for (const call of toolCalls) {
      const name = String(call?.function?.name || call?.name || "").toLowerCase().replace(/[_-]/g, "");
      if (!mutationTools.has(name)) continue;
      const parsed = typeof call?.function?.arguments === "string" ? parseRawJson(call.function.arguments) : call?.function?.arguments;
      const args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      if (!args) continue;
      const candidate = String((args as any).path ?? (args as any).filePath ?? (args as any).file_path ?? "").trim();
      if (!candidate) continue;
      const existing = resolveExistingFile(candidate);
      if (!existing) continue;
      targetPath = candidate;
      reason = name;
      break;
    }
    if (!targetPath) return { staged: false };

    const readInfo = findTool(registry, "read") || findTool(registry, "readfile");
    if (!readInfo) return { staged: false };
    const readName = readInfo.tool.function?.name || readInfo.tool.name || "read";
    const readKey = readInfo.argKeys?.includes("filePath")
      ? "filePath"
      : readInfo.argKeys?.includes("file_path")
        ? "file_path"
        : "path";
    const stageId = `call_stage_read_${crypto.randomUUID().slice(0, 8)}`;
    pendingStagedMutations.set(stageId, { toolCalls, createdAt: Date.now(), targetPath, reason });
    debugDump("pending_stage_set", { id: stageId, reason, targetPath });

    const readCall = [
      {
        id: stageId,
        index: 0,
        type: "function",
        function: {
          name: readName,
          arguments: JSON.stringify({ [readKey]: targetPath }),
        },
      },
    ];
    const stageUsage = buildToolUsage(promptTokens, readCall);
    applyResponseHeaders(reply, stats);
    sendToolCalls(reply, readCall, model, stream, headers, stageUsage, reasoningContent);
    return { staged: true };
  };

  const buildConfirmationScope = (request: FastifyRequest): string => {
    const body = (request.body as any) || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sessionHints = [
      String((request.headers as any)?.["x-opencode-session-id"] || ""),
      String((request.headers as any)?.["x-session-id"] || ""),
      String((request.headers as any)?.["x-chat-id"] || ""),
    ]
      .map((value) => value.trim())
      .filter(Boolean);
    const toolNames = (Array.isArray(body.tools) ? body.tools : [])
      .map((tool: any) => String(tool?.function?.name || tool?.name || "").trim().toLowerCase())
      .filter(Boolean);
    const latestUser = normalizeUserIntent(extractLatestUserText(messages));
    const keyPayload = JSON.stringify({
      model: String(body.model || DEFAULT_MODEL),
      sessionHints,
      toolNames,
      latestUser,
    });
    return crypto.createHash("sha256").update(keyPayload).digest("hex").slice(0, 24) || DEFAULT_SCOPE;
  };

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
    requiredToolName,
    confirmationScope = DEFAULT_SCOPE,
  ) => {
    if (!registry) {
      const content = "Tool registry missing; cannot validate tool calls.";
      if (stream) {
        return sendStreamContent(reply, content, model, stats, promptTokens);
      }
      return sendContent(reply, content, model, promptTokens, stats);
    }
    const guard = traceSync(
      "guard_validate_tool_calls",
      () => validateToolCalls(toolCalls, source, registry, requiredToolName),
      {
        source,
        toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
        requiredToolName: requiredToolName || null,
      },
    );
    if (!guard.ok) {
      debugDump("guard_block", {
        source,
        reason: guard.reason,
        hasConfirmation: Boolean(guard.confirmationToolCalls?.length),
        toolCalls: toolCalls?.map((c: any) => ({
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
            scope: confirmationScope || DEFAULT_SCOPE,
          });
          debugDump("pending_confirmation_set", {
            id: guard.pendingConfirmation.id,
            blockedReason: guard.pendingConfirmation.blockedReason,
            scope: confirmationScope || DEFAULT_SCOPE,
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

    const staged = maybeStageFileMutation({
      reply,
      toolCalls,
      model,
      stream,
      headers,
      usage,
      promptTokens,
      stats,
      registry,
      confirmationScope,
      reasoningContent,
    });
    if (staged.staged) return reply;

    debugDump("response_tool_calls", {
      model,
      source,
      toolCalls: toolCalls.map((c: any) => ({
        id: c?.id,
        name: c?.function?.name || c?.name,
        argumentsPreview:
          typeof c?.function?.arguments === "string" ? truncate(c.function.arguments, 1200) : undefined,
      })),
    });
    return sendToolCalls(
      reply,
      toolCalls,
      model,
      stream,
      headers,
      usage,
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
    for (const [id, entry] of pendingStagedMutations.entries()) {
      if (now - entry.createdAt > PENDING_CONFIRM_TTL_MS) pendingStagedMutations.delete(id);
    }

    const body = request.body as any;
    const model = body.model || DEFAULT_MODEL;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return { handled: false };

    const last = messages[messages.length - 1];
    if (last?.role !== "tool") return { handled: false };
    const toolCallId = String(last?.tool_call_id || last?.toolCallId || "").trim();
    if (!toolCallId) return { handled: false };

    const staged = pendingStagedMutations.get(toolCallId);
    if (staged) {
      pendingStagedMutations.delete(toolCallId);
      debugDump("pending_stage_replay", { id: toolCallId, reason: staged.reason, targetPath: staged.targetPath });
      const stream = Boolean(body.stream);
      const headers: Record<string, string> = {};
      sendToolCalls(reply, staged.toolCalls, model, stream, headers, undefined);
      return { handled: true };
    }

    const pending = pendingConfirmations.get(toolCallId);
    if (!pending) return { handled: false };
    const requestScope = buildConfirmationScope(request);
    if ((pending.scope || DEFAULT_SCOPE) !== (requestScope || DEFAULT_SCOPE)) {
      debugDump("pending_confirmation_scope_mismatch", {
        id: toolCallId,
        blockedReason: pending.blockedReason,
      });
      return { handled: false };
    }

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

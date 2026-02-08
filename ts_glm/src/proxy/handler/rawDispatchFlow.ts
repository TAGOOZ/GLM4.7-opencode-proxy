import type { FastifyReply } from "fastify";
import type { ContextStats } from "../context.js";
import { PROXY_DEBUG } from "../constants.js";
import type { ToolInfo } from "../tools/registry.js";
import type { GuardAndSendToolCalls } from "./flowTypes.js";
import { isRawToolCallsAllowed } from "./guards.js";
import { prepareRawToolCalls, type RawDispatchContext } from "./rawToolCalls.js";
import { buildToolUsage } from "./utils.js";

type TryDispatchRawToolCallsParams = {
  rawToolCalls: any[] | null;
  reply: FastifyReply;
  model: string;
  stream: boolean;
  streamHeaders: Record<string, string>;
  promptTokens: number;
  stats?: ContextStats;
  toolRegistry: Map<string, ToolInfo>;
  rawDispatchContext: RawDispatchContext;
  lastRawDispatchSignature: string;
  lastRawDispatchUser: string;
  guardAndSendToolCalls: GuardAndSendToolCalls;
  reasoningContent?: string;
  requiredToolName?: string | null;
  confirmationScope?: string;
  logBlocked?: boolean;
  logSuppressed?: boolean;
};

export const tryDispatchRawToolCalls = (params: TryDispatchRawToolCallsParams): unknown | null => {
  const {
    rawToolCalls,
    reply,
    model,
    stream,
    streamHeaders,
    promptTokens,
    stats,
    toolRegistry,
    rawDispatchContext,
    lastRawDispatchSignature,
    lastRawDispatchUser,
    guardAndSendToolCalls,
    reasoningContent,
    requiredToolName,
    confirmationScope,
    logBlocked = true,
    logSuppressed = true,
  } = params;

  if (!rawToolCalls) return null;
  if (!isRawToolCallsAllowed(rawToolCalls)) {
    if (PROXY_DEBUG && logBlocked) {
      console.log("proxy_debug raw_tool_calls_blocked: true");
    }
    return null;
  }

  const prepared = prepareRawToolCalls(rawToolCalls, rawDispatchContext, toolRegistry, {
    signature: lastRawDispatchSignature,
    user: lastRawDispatchUser,
  });
  if (!prepared) {
    if (PROXY_DEBUG && logSuppressed) {
      console.log("proxy_debug raw_tool_calls_suppressed: true");
    }
    return null;
  }

  return guardAndSendToolCalls(
    reply,
    prepared.toolCalls,
    model,
    stream,
    streamHeaders,
    buildToolUsage(promptTokens, prepared.toolCalls),
    promptTokens,
    stats,
    "raw",
    toolRegistry,
    {
      ...rawDispatchContext,
      rawSignature: prepared.signature,
    },
    reasoningContent,
    requiredToolName,
    confirmationScope,
  );
};

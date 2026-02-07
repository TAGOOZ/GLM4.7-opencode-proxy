import crypto from "crypto";
import type { ContextStats } from "../context.js";
import { PROXY_DEBUG } from "../constants.js";
import { estimateMessagesTokens } from "../context.js";
import {
  applyMutationActionBoundary,
  isRawToolCallsAllowed,
  validatePlannerActions,
} from "./guards.js";
import { filterPlannerActions } from "../tools/policy.js";
import { findTool, normalizeArgsForTool } from "../tools/registry.js";
import { parseRawToolCalls, tryParseModelOutput, tryRepairPlannerOutput } from "../tools/parse.js";
import { inferRecentFilePath } from "../tools/path.js";
import { buildInstructionMessages } from "./messageHelpers.js";
import { prepareRawToolCalls } from "./rawToolCalls.js";
import { buildToolUsage, extractPlannerFinal } from "./utils.js";
import type { PlannerFlowContext, PlannerFlowDeps } from "./flowTypes.js";

export const maybeRecoverEmptyActions = async (params: {
  deps: PlannerFlowDeps;
  ctx: PlannerFlowContext;
  activeChatId: string;
}) => {
  const { deps, ctx, activeChatId } = params;
  const {
    reply,
    model,
    stream,
    streamHeaders,
    toolRegistry,
    rawDispatchContext,
    lastRawDispatchSignature,
    lastRawDispatchUser,
    messages,
    tools,
    sanitizedMessages,
    allowTodoWrite,
    collectModelResponse,
    thinkingRef,
  } = ctx;

  const dispatchRecoveryActions = (actions: any[], promptTokens: number, stats: ContextStats) => {
    const policyFiltered = filterPlannerActions(actions, {
      allowTodoTools: allowTodoWrite,
    });
    const filteredActions = policyFiltered.actions;
    if (filteredActions.length === 0) return null;
    const structuralRecovery = validatePlannerActions(filteredActions as any);
    if (!structuralRecovery.ok) return null;
    const invalidRecovery = filteredActions.find((action: any) => !findTool(toolRegistry, action?.tool || ""));
    if (invalidRecovery) return null;
    const boundedRecoveryActions = applyMutationActionBoundary(filteredActions as any, toolRegistry);
    const recoveryToolCalls = boundedRecoveryActions.actions.map((action, idx) => {
      const toolInfo = findTool(toolRegistry, action.tool);
      const toolName = toolInfo?.tool.function?.name || toolInfo?.tool.name || action.tool;
      let args = normalizeArgsForTool(toolInfo, action.args || {});
      const normalizedTool = String(toolName || "").toLowerCase().replace(/[_-]/g, "");
      const needsPath = normalizedTool === "read" || normalizedTool === "readfile";
      const hasPath = args.path != null || (args as any).filePath != null || (args as any).file_path != null;
      if (needsPath && !hasPath) {
        const inferred = inferRecentFilePath(sanitizedMessages);
        if (inferred) {
          const key = toolInfo?.argKeys?.includes("filePath") ? "filePath" : "path";
          args = { ...args, [key]: inferred };
        }
      }
      return {
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        index: idx,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
      };
    });
    return deps.guardAndSendToolCalls(
      reply,
      recoveryToolCalls,
      model,
      stream,
      streamHeaders,
      buildToolUsage(promptTokens, recoveryToolCalls),
      promptTokens,
      stats,
      "planner",
      toolRegistry,
      undefined,
      thinkingRef.value,
    );
  };

  const parseRecoveryPayload = (text: string) => {
    let parsedRecovery = tryParseModelOutput(text, false);
    if (!parsedRecovery.ok || !parsedRecovery.data) {
      const repairedRecovery = tryRepairPlannerOutput(text);
      if (repairedRecovery) {
        parsedRecovery = { ok: true, data: repairedRecovery };
      }
    }
    return parsedRecovery;
  };

  if (PROXY_DEBUG) {
    console.log("proxy_debug empty_action_recovery: attempt");
  }
  const recoveryPayload = buildInstructionMessages(
    deps.contextConfig,
    "You received tool results but returned no actionable response. Continue the task. Return ONLY a JSON object matching the schema. If more tools are needed, include actions. Do not return todowrite-only status updates unless the user explicitly asked for a todo/checklist.",
    messages,
    tools,
  );
  const recoveryText = await collectModelResponse(activeChatId, recoveryPayload.messages);
  const recoveryPromptTokens = estimateMessagesTokens(recoveryPayload.messages);

  const recoveryRawToolCalls = parseRawToolCalls(recoveryText, toolRegistry);
  if (recoveryRawToolCalls && isRawToolCallsAllowed(recoveryRawToolCalls)) {
    const prepared = prepareRawToolCalls(recoveryRawToolCalls, rawDispatchContext, toolRegistry, {
      signature: lastRawDispatchSignature,
      user: lastRawDispatchUser,
    });
    if (prepared) {
      return deps.guardAndSendToolCalls(
        reply,
        prepared.toolCalls,
        model,
        stream,
        streamHeaders,
        buildToolUsage(recoveryPromptTokens, prepared.toolCalls),
        recoveryPromptTokens,
        recoveryPayload.stats,
        "raw",
        toolRegistry,
        {
          ...rawDispatchContext,
          rawSignature: prepared.signature,
        },
        thinkingRef.value,
      );
    }
    if (PROXY_DEBUG) {
      console.log("proxy_debug raw_tool_calls_suppressed: true");
    }
  }

  let recovered = parseRecoveryPayload(recoveryText);
  if (recovered.ok && recovered.data && recovered.data.actions.length > 0) {
    const dispatched = dispatchRecoveryActions(
      recovered.data.actions as any,
      recoveryPromptTokens,
      recoveryPayload.stats,
    );
    if (dispatched) {
      return dispatched;
    }
  }

  const recoveredFinal =
    extractPlannerFinal(recoveryText) ||
    (recovered.ok && recovered.data ? recovered.data.final : "") ||
    "No further actions were produced; task may require another explicit user prompt.";
  if (stream) {
    return deps.sendStreamContent(
      reply,
      recoveredFinal,
      model,
      recoveryPayload.stats,
      recoveryPromptTokens,
      thinkingRef.value,
    );
  }
  return deps.sendContent(reply, recoveredFinal, model, recoveryPromptTokens, recoveryPayload.stats);
};

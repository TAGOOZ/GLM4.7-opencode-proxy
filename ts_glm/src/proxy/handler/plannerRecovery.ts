import type { ContextStats } from "../context.js";
import { PROXY_DEBUG } from "../constants.js";
import { estimateMessagesTokens } from "../context.js";
import {
  applyMutationActionBoundary,
  validatePlannerActions,
} from "./guards.js";
import { filterPlannerActions } from "../tools/policy.js";
import { findTool } from "../tools/registry.js";
import { parseRawToolCalls, tryParseModelOutput, tryRepairPlannerOutput } from "../tools/parse.js";
import { buildInstructionMessages } from "./messageHelpers.js";
import { buildToolUsage, extractPlannerFinal } from "./utils.js";
import type { PlannerFlowContext, PlannerFlowDeps } from "./flowTypes.js";
import { tryDispatchRawToolCalls } from "./rawDispatchFlow.js";
import { buildPlannerActionToolCall } from "./plannerActions.js";

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
    toolChoiceFunctionName,
    confirmationScope,
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
    const recoveryToolCalls = boundedRecoveryActions.actions.map((action, idx) =>
      buildPlannerActionToolCall({
        action,
        index: idx,
        toolRegistry,
        sanitizedMessages,
      }),
    );
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
      toolChoiceFunctionName,
      confirmationScope,
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

  const recoveryRawDispatch = tryDispatchRawToolCalls({
    rawToolCalls: parseRawToolCalls(recoveryText, toolRegistry, {
      allowProseEnvelope: false,
    }),
    reply,
    model,
    stream,
    streamHeaders,
    promptTokens: recoveryPromptTokens,
    stats: recoveryPayload.stats,
    toolRegistry,
    rawDispatchContext,
    lastRawDispatchSignature,
    lastRawDispatchUser,
    guardAndSendToolCalls: deps.guardAndSendToolCalls,
    reasoningContent: thinkingRef.value,
    requiredToolName: toolChoiceFunctionName,
    confirmationScope,
    logBlocked: false,
  });
  if (recoveryRawDispatch) {
    return recoveryRawDispatch;
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

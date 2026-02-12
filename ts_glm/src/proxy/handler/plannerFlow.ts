import {
  ACTIONABLE_KEYWORDS,
  PROXY_DEBUG,
  PROXY_INCLUDE_HISTORY_IN_REQUEST,
  PROXY_PLANNER_COERCE,
} from "../constants.js";
import crypto from "node:crypto";
import { estimateMessagesTokens } from "../context.js";
import { openaiContentResponse } from "../openai.js";
import { validatePlannerActions } from "./guards.js";
import { inferListToolCall, inferReadToolCall, inferSearchToolCall } from "../tools/infer.js";
import { findTool } from "../tools/registry.js";
import { parseRawToolCalls, tryParseModelOutput, tryRepairPlannerOutput } from "../tools/parse.js";
import { buildInstructionMessages } from "./messageHelpers.js";
import {
  applyResponseHeaders,
  buildToolUsage,
  buildUsage,
  detectUnknownToolFromUserJson,
  extractPlannerFinal,
} from "./utils.js";
import { parsePlannerOutput } from "./plannerParsing.js";
import { tryDispatchRawToolCalls } from "./rawDispatchFlow.js";
import {
  buildPlannerToolCalls,
  filterPlannerActionsWithPolicy,
  limitPlannerActions,
} from "./plannerActions.js";
import { maybeRecoverEmptyActions } from "./plannerRecovery.js";
import type { PlannerFlowContext, PlannerFlowDeps } from "./flowTypes.js";

const CODE_LIKE_FINAL_REGEX =
  /```|<!doctype html>|<html[\s>]|^\s*(import|export|function|class|const|let|var)\b|;\s*$/im;
const STALL_REPEAT_LIMIT = 3;
const INSPECT_TOOL_NAMES = new Set(["read", "glob", "grep", "ls", "list"]);

const stableStringify = (value: any): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
};

const toolClass = (tool: string): "inspect" | "mutate" | "execute" | "other" => {
  const name = String(tool || "").trim().toLowerCase();
  if (INSPECT_TOOL_NAMES.has(name)) return "inspect";
  if (name === "edit" || name === "write") return "mutate";
  if (name === "bash" || name === "task") return "execute";
  return "other";
};

const hashText = (value: string): string => {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
};

export const createPlannerFlow = (deps: PlannerFlowDeps) => {
  const plannerStallState = new Map<string, { actionSignature: string; resultHash: string; repeatCount: number }>();

  const handlePlannerFlow = async (ctx: PlannerFlowContext) => {
    let responsePromptTokens = ctx.responsePromptTokens;
    let glmMessages = ctx.glmMessages;
    let glmStats = ctx.glmStats;
    const {
      reply,
      model,
      stream,
      streamHeaders,
      toolRegistry,
      rawDispatchContext,
      lastRawDispatchSignature,
      lastRawDispatchUser,
      lastUser,
      allowHeuristicTools,
      explicitToolCalls,
      inferredToolCall,
      toolChoiceRequired,
      toolChoiceFunctionName,
      confirmationScope,
      tools,
      messages,
      sanitizedMessages,
      hasToolResult,
      toolResultCount,
      maxToolLoops,
      allowTodoWrite,
      useHistoryThisRequest,
      collectModelResponse,
      getChatId,
      thinkingRef,
    } = ctx;

    // If the user provides explicit planner JSON that references unknown tools, fail fast
    // instead of relying on the model to echo invalid JSON.
    const unknown = detectUnknownToolFromUserJson(lastUser, toolRegistry);
    if (unknown) {
      const content = `Unknown tool: ${unknown}`;
      if (stream) {
        return deps.sendStreamContent(reply, content, model, glmStats, responsePromptTokens);
      }
      return deps.sendContent(reply, content, model, responsePromptTokens, glmStats);
    }

    const earlyFallback = explicitToolCalls || inferredToolCall;
    const earlySource: "planner" | "raw" | "heuristic" | "explicit" =
      explicitToolCalls ? "explicit" : inferredToolCall ? "heuristic" : "planner";
    if (PROXY_DEBUG) {
      console.log("proxy_debug tools:", tools.map((t: any) => t.function?.name || t.name || "tool"));
      console.log("proxy_debug lastUser:", lastUser);
      console.log("proxy_debug earlyFallback:", Boolean(earlyFallback));
    }
    if (earlyFallback) {
      return deps.guardAndSendToolCalls(
        reply,
        earlyFallback,
        model,
        stream,
        streamHeaders,
        buildToolUsage(responsePromptTokens, earlyFallback),
        responsePromptTokens,
        glmStats,
        earlySource,
        toolRegistry,
        undefined,
        thinkingRef.value,
        toolChoiceFunctionName,
        confirmationScope,
      );
    }

    const activeChatId = await getChatId();
    const dispatchRaw = (rawToolCalls: any[] | null) => {
      return tryDispatchRawToolCalls({
        rawToolCalls,
        reply,
        model,
        stream,
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
    };
    const dispatchHeuristicFallback = () => {
      if (!allowHeuristicTools) return null;
      const fallbackTools =
        inferReadToolCall(toolRegistry, lastUser) ||
        inferListToolCall(toolRegistry, lastUser) ||
        inferSearchToolCall(toolRegistry, lastUser);
      if (!fallbackTools) return null;
      return deps.guardAndSendToolCalls(
        reply,
        fallbackTools,
        model,
        stream,
        streamHeaders,
        buildToolUsage(responsePromptTokens, fallbackTools),
        responsePromptTokens,
        glmStats,
        "heuristic",
        toolRegistry,
        undefined,
        thinkingRef.value,
        toolChoiceFunctionName,
        confirmationScope,
      );
    };
    const sendFinalContent = (content: string, promptTokens: number, stats = glmStats) => {
      if (stream) {
        return deps.sendStreamContent(reply, content, model, stats, promptTokens, thinkingRef.value);
      }
      return deps.sendContent(reply, content, model, promptTokens, stats);
    };
    const requestInstructionFinal = async (instruction: string) => {
      const finalPayload = buildInstructionMessages(deps.contextConfig, instruction, messages, []);
      const finalText = await collectModelResponse(activeChatId, finalPayload.messages);
      const finalPromptTokens = estimateMessagesTokens(finalPayload.messages);
      const finalContent = extractPlannerFinal(finalText) ?? finalText;
      return sendFinalContent(finalContent, finalPromptTokens, finalPayload.stats);
    };
    let plannerParentMessageId: string | null | undefined = undefined;
    if (!useHistoryThisRequest || !PROXY_INCLUDE_HISTORY_IN_REQUEST) {
      // Planner retries can otherwise incur repeated getChat() calls via getCurrentMessageId().
      // Resolve once per turn and reuse across retries.
      try {
        plannerParentMessageId = await deps.client.getCurrentMessageId(activeChatId);
      } catch {
        plannerParentMessageId = null;
      }
    }
    let responseText = await collectModelResponse(activeChatId, glmMessages, {
      parentMessageId: plannerParentMessageId,
    });
    const initialResponseText = responseText;
    if (PROXY_DEBUG) {
      const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}...` : responseText;
      console.log("proxy_debug model_raw:", preview);
    }
    const parseRawToolCallsLenient = (text: string) => {
      const strict = parseRawToolCalls(text, toolRegistry, {
        allowProseEnvelope: false,
      });
      if (strict) return strict;
      return parseRawToolCalls(text, toolRegistry, {
        allowProseEnvelope: true,
      });
    };
    const earlyRawToolCalls = parseRawToolCallsLenient(responseText);
    const earlyRawDispatch = dispatchRaw(earlyRawToolCalls);
    if (earlyRawDispatch) {
      return earlyRawDispatch;
    }

    const parsedResult = await parsePlannerOutput({
      activeChatId,
      glmMessages,
      initialResponseText,
      responsePromptTokens,
      collectModelResponse,
      plannerParentMessageId,
    });
    responseText = parsedResult.responseText;
    responsePromptTokens = parsedResult.responsePromptTokens;
    let parsed = parsedResult.parsed;

    const maybeRawToolCalls =
      (!parsed.ok || !parsed.data || (parsed.data.actions.length === 0 && responseText.trim().startsWith("[")))
        ? parseRawToolCallsLenient(responseText)
        : null;
    const maybeRawDispatch = dispatchRaw(maybeRawToolCalls);
    if (maybeRawDispatch) {
      return maybeRawDispatch;
    }

    if (!parsed.ok || !parsed.data) {
      if (PROXY_PLANNER_COERCE && !toolChoiceRequired) {
        parsed = {
          ok: true,
          data: {
            plan: ["answer directly"],
            actions: [],
            final: responseText.trim(),
          },
        };
      }
    }

    if (!parsed.ok || !parsed.data) {
      const rawToolCalls = parseRawToolCallsLenient(responseText);
      const fallbackRawDispatch = dispatchRaw(rawToolCalls);
      if (fallbackRawDispatch) {
        return fallbackRawDispatch;
      }
      if (hasToolResult) {
        const content =
          "I could not parse a valid planner JSON response after tool results. Please retry the request.";
        return sendFinalContent(content, responsePromptTokens, glmStats);
      }
      const heuristicFallback = dispatchHeuristicFallback();
      if (heuristicFallback) return heuristicFallback;
      if (!toolChoiceRequired) {
        return requestInstructionFinal(
          "Answer the user directly. Return ONLY a JSON object matching the schema (actions empty, include final). No extra text or analysis.",
        );
      }
      const fallback = openaiContentResponse(
        "Unable to generate tool call.",
        model,
        buildUsage(responsePromptTokens, "Unable to generate tool call."),
      );
      if (stream) {
        return deps.sendStreamContent(reply, "Unable to generate tool call.", model, glmStats, responsePromptTokens);
      }
      applyResponseHeaders(reply, glmStats);
      return reply.send(fallback);
    }

    const normalizeParsedData = (input: any) => {
      let normalized = limitPlannerActions(input);
      if (Array.isArray(normalized.actions) && normalized.actions.length > 0) {
        normalized = {
          ...normalized,
          actions: filterPlannerActionsWithPolicy(normalized.actions as any[], toolRegistry, allowTodoWrite),
        };
      }
      if (Array.isArray(normalized.actions) && normalized.actions.length > 0) {
        const knownActions = normalized.actions.filter((action: any) => findTool(toolRegistry, action.tool));
        if (knownActions.length !== normalized.actions.length) {
          const dropped = normalized.actions.length - knownActions.length;
          if (PROXY_DEBUG) {
            console.log(
              "proxy_debug planner_actions_filtered_unknown:",
              JSON.stringify({
                originalCount: normalized.actions.length,
                keptCount: knownActions.length,
                droppedCount: dropped,
              }),
            );
          }
          if (toolChoiceRequired && knownActions.length === 0) {
            const unknownTool = String(normalized.actions[0]?.tool || "");
            return { error: `Unknown tool: ${unknownTool}` };
          }
          normalized = { ...normalized, actions: knownActions };
        }
      }
      return { data: normalized };
    };

    let parsedDataResult = normalizeParsedData(parsed.data);
    if ("error" in parsedDataResult) {
      const content = String(parsedDataResult.error || "Unknown tool.");
      if (stream) {
        return deps.sendStreamContent(reply, content, model, glmStats, responsePromptTokens);
      }
      return deps.sendContent(reply, content, model, responsePromptTokens, glmStats);
    }
    let parsedData = parsedDataResult.data;
    if (PROXY_DEBUG) {
      console.log("proxy_debug parsed_actions:", parsedData.actions.length);
      if (parsedData.actions.length) {
        console.log("proxy_debug action_tools:", parsedData.actions.map((a: any) => a.tool).join(","));
      }
    }

    const actionableIntent = ACTIONABLE_KEYWORDS.some((kw) => String(lastUser || "").toLowerCase().includes(kw));
    const finalText = String(parsedData.final || "");
    const hasCodeLikeFinal = CODE_LIKE_FINAL_REGEX.test(finalText);
    const shouldRepairActionShape =
      !hasToolResult &&
      tools.length > 0 &&
      parsedData.actions.length === 0 &&
      actionableIntent &&
      hasCodeLikeFinal;

    if (shouldRepairActionShape) {
      const repairInstruction = {
        role: "system" as const,
        content:
          "Actionable request detected with tools available. Return ONLY valid planner JSON. actions must include at least one executable tool call. Do not include implementation/code in final.",
      };
      const repairMessages = [...glmMessages, repairInstruction];
      const repairText = await collectModelResponse(activeChatId, repairMessages, {
        parentMessageId: plannerParentMessageId,
      });
      responsePromptTokens = estimateMessagesTokens(repairMessages);
      if (PROXY_DEBUG) {
        const preview = repairText.length > 400 ? `${repairText.slice(0, 400)}...` : repairText;
        console.log("proxy_debug planner_action_shape_retry_raw:", preview);
      }
      const repairRawDispatch = dispatchRaw(parseRawToolCallsLenient(repairText));
      if (repairRawDispatch) {
        return repairRawDispatch;
      }
      let repaired = tryParseModelOutput(repairText, false);
      if (!repaired.ok || !repaired.data) {
        const repairedData = tryRepairPlannerOutput(repairText);
        if (repairedData) {
          repaired = { ok: true, data: repairedData };
        }
      }
      if (!repaired.ok || !repaired.data) {
        const content = "Model returned invalid planner JSON for an actionable request. Please retry.";
        return sendFinalContent(content, responsePromptTokens, glmStats);
      }
      parsedDataResult = normalizeParsedData(repaired.data);
      if ("error" in parsedDataResult) {
        const content = String(parsedDataResult.error || "Unknown tool.");
        if (stream) {
          return deps.sendStreamContent(reply, content, model, glmStats, responsePromptTokens);
        }
        return deps.sendContent(reply, content, model, responsePromptTokens, glmStats);
      }
      parsedData = parsedDataResult.data;
      if (parsedData.actions.length === 0) {
        const content = "Planner produced no executable actions for an actionable request. Please retry.";
        return sendFinalContent(content, responsePromptTokens, glmStats);
      }
    }

    const structural = validatePlannerActions(parsedData.actions as any);
    if (!structural.ok) {
      const content = `Blocked invalid plan (${structural.reason}).`;
      if (stream) {
        return deps.sendStreamContent(reply, content, model, glmStats, responsePromptTokens);
      }
      return deps.sendContent(reply, content, model, responsePromptTokens, glmStats);
    }

    if (hasToolResult && parsedData.actions.length > 0 && toolResultCount >= maxToolLoops) {
      if (PROXY_DEBUG) {
        console.log("proxy_debug tool_loop_limit: true");
      }
      return requestInstructionFinal(
        "Tool loop limit reached. Use the tool results above to answer the user. Return ONLY a JSON object matching the schema (actions empty, include final). No extra text or analysis.",
      );
    }

    if (parsedData.actions.length === 0) {
      const recoveredRawDispatch = dispatchRaw(parseRawToolCallsLenient(responseText));
      if (recoveredRawDispatch) {
        return recoveredRawDispatch;
      }
      if (hasToolResult && !String(parsedData.final || "").trim()) {
        return maybeRecoverEmptyActions({
          deps,
          ctx,
          activeChatId,
        });
      }
      if (!hasToolResult) {
        const heuristicFallback = dispatchHeuristicFallback();
        if (heuristicFallback) return heuristicFallback;
      }
      const content = parsedData.final || "";
      return sendFinalContent(content, responsePromptTokens, glmStats);
    }

    const primaryAction = parsedData.actions[0];
    if (primaryAction) {
      const primaryClass = toolClass(primaryAction.tool);
      const primarySignature = `${String(primaryAction.tool || "").toLowerCase()}:${stableStringify(primaryAction.args || {})}`;
      const latestToolMessage = [...sanitizedMessages].reverse().find((msg: any) => msg?.role === "tool" || msg?.tool_call_id);
      const latestToolResultHash = hashText(String(latestToolMessage?.content || ""));
      const previous = plannerStallState.get(confirmationScope);
      const isSameStep =
        previous &&
        previous.actionSignature === primarySignature &&
        previous.resultHash === latestToolResultHash &&
        primaryClass === "inspect" &&
        hasToolResult;
      const repeatCount = isSameStep ? previous.repeatCount + 1 : 1;
      plannerStallState.set(confirmationScope, {
        actionSignature: primarySignature,
        resultHash: latestToolResultHash,
        repeatCount,
      });
      if (isSameStep && repeatCount >= STALL_REPEAT_LIMIT && !toolChoiceRequired) {
        if (PROXY_DEBUG) {
          console.log(
            "proxy_debug planner_stall_detected:",
            JSON.stringify({
              confirmationScope,
              repeatCount,
              actionSignature: primarySignature,
            }),
          );
        }
        return requestInstructionFinal(
          "The same inspection step repeated without new evidence. Using existing tool results, either provide the final answer now or explicitly state what cannot be verified yet. Return concise final output.",
        );
      }
    }

    const { toolCalls } = buildPlannerToolCalls({
      actions: parsedData.actions as any[],
      toolRegistry,
      sanitizedMessages,
    });

    return deps.guardAndSendToolCalls(
      reply,
      toolCalls,
      model,
      stream,
      streamHeaders,
      buildToolUsage(responsePromptTokens, toolCalls),
      responsePromptTokens,
      glmStats,
      "planner",
      toolRegistry,
      undefined,
      thinkingRef.value,
      toolChoiceFunctionName,
      confirmationScope,
    );
  };

  return { handlePlannerFlow };
};

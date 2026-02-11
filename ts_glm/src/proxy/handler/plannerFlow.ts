import {
  PLANNER_JSON_HINT_REGEX,
  PROXY_DEBUG,
  PROXY_PLANNER_COERCE,
} from "../constants.js";
import { estimateMessagesTokens } from "../context.js";
import { openaiContentResponse } from "../openai.js";
import { validatePlannerActions } from "./guards.js";
import { inferListToolCall, inferReadToolCall, inferSearchToolCall } from "../tools/infer.js";
import { findTool } from "../tools/registry.js";
import { parseRawToolCalls } from "../tools/parse.js";
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

export const createPlannerFlow = (deps: PlannerFlowDeps) => {
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
    if (!useHistoryThisRequest) {
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
        const looksLikePlannerJson =
          PLANNER_JSON_HINT_REGEX.test(responseText) || responseText.trim().startsWith("{");
        if (looksLikePlannerJson) {
          const finalPayload = buildInstructionMessages(deps.contextConfig, deps.postToolSystem, messages, tools);
          const finalText = await collectModelResponse(activeChatId, finalPayload.messages);
          const finalPromptTokens = estimateMessagesTokens(finalPayload.messages);
          const extractedFinal = extractPlannerFinal(finalText) ?? extractPlannerFinal(responseText);
          const finalContent = extractedFinal ?? finalText;
          return sendFinalContent(finalContent, finalPromptTokens, finalPayload.stats);
        }
      }
      if (hasToolResult && responseText.trim()) {
        const extractedFinal = extractPlannerFinal(responseText);
        const finalContent = extractedFinal ?? responseText;
        return sendFinalContent(finalContent, responsePromptTokens, glmStats);
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

    let parsedData = limitPlannerActions(parsed.data);
    if (PROXY_DEBUG) {
      console.log("proxy_debug parsed_actions:", parsedData.actions.length);
      if (parsedData.actions.length) {
        console.log("proxy_debug action_tools:", parsedData.actions.map((a: any) => a.tool).join(","));
      }
    }
    if (Array.isArray(parsedData.actions) && parsedData.actions.length > 0) {
      parsedData = {
        ...parsedData,
        actions: filterPlannerActionsWithPolicy(parsedData.actions as any[], toolRegistry, allowTodoWrite),
      };
    }
    if (Array.isArray(parsedData.actions) && parsedData.actions.length > 0) {
      const knownActions = parsedData.actions.filter((action: any) => findTool(toolRegistry, action.tool));
      if (knownActions.length !== parsedData.actions.length) {
        const dropped = parsedData.actions.length - knownActions.length;
        if (PROXY_DEBUG) {
          console.log(
            "proxy_debug planner_actions_filtered_unknown:",
            JSON.stringify({
              originalCount: parsedData.actions.length,
              keptCount: knownActions.length,
              droppedCount: dropped,
            }),
          );
        }
        if (toolChoiceRequired && knownActions.length === 0) {
          const unknownTool = String(parsedData.actions[0]?.tool || "");
          const content = `Unknown tool: ${unknownTool}`;
          if (stream) {
            return deps.sendStreamContent(reply, content, model, glmStats, responsePromptTokens);
          }
          return deps.sendContent(reply, content, model, responsePromptTokens, glmStats);
        }
        parsedData = { ...parsedData, actions: knownActions };
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

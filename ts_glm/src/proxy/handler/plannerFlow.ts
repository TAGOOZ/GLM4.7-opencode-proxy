import {
  PLANNER_JSON_HINT_REGEX,
  PROXY_DEBUG,
  PROXY_PLANNER_COERCE,
} from "../constants.js";
import { estimateMessagesTokens } from "../context.js";
import { openaiContentResponse } from "../openai.js";
import { isRawToolCallsAllowed, validatePlannerActions } from "./guards.js";
import { inferListToolCall, inferReadToolCall, inferSearchToolCall } from "../tools/infer.js";
import { findTool } from "../tools/registry.js";
import { parseRawToolCalls } from "../tools/parse.js";
import { buildInstructionMessages } from "./messageHelpers.js";
import { prepareRawToolCalls } from "./rawToolCalls.js";
import {
  applyResponseHeaders,
  buildToolUsage,
  buildUsage,
  detectUnknownToolFromUserJson,
  extractPlannerFinal,
} from "./utils.js";
import { parsePlannerOutput } from "./plannerParsing.js";
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
      );
    }

    const activeChatId = await getChatId();
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
    const earlyRawToolCalls = parseRawToolCalls(responseText, toolRegistry);
    if (earlyRawToolCalls && isRawToolCallsAllowed(earlyRawToolCalls)) {
      const prepared = prepareRawToolCalls(earlyRawToolCalls, rawDispatchContext, toolRegistry, {
        signature: lastRawDispatchSignature,
        user: lastRawDispatchUser,
      });
      if (!prepared) {
        if (PROXY_DEBUG) {
          console.log("proxy_debug raw_tool_calls_suppressed: true");
        }
      } else {
        return deps.guardAndSendToolCalls(
          reply,
          prepared.toolCalls,
          model,
          stream,
          streamHeaders,
          buildToolUsage(responsePromptTokens, prepared.toolCalls),
          responsePromptTokens,
          glmStats,
          "raw",
          toolRegistry,
          {
            ...rawDispatchContext,
            rawSignature: prepared.signature,
          },
          thinkingRef.value,
        );
      }
    } else if (earlyRawToolCalls && PROXY_DEBUG) {
      console.log("proxy_debug raw_tool_calls_blocked: true");
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
        ? parseRawToolCalls(responseText, toolRegistry)
        : null;
    if (maybeRawToolCalls) {
      if (isRawToolCallsAllowed(maybeRawToolCalls)) {
        const prepared = prepareRawToolCalls(maybeRawToolCalls, rawDispatchContext, toolRegistry, {
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
            buildToolUsage(responsePromptTokens, prepared.toolCalls),
            responsePromptTokens,
            glmStats,
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
      if (PROXY_DEBUG) {
        console.log("proxy_debug raw_tool_calls_blocked: true");
      }
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
      const rawToolCalls = parseRawToolCalls(responseText, toolRegistry);
      if (rawToolCalls) {
        if (isRawToolCallsAllowed(rawToolCalls)) {
          const prepared = prepareRawToolCalls(rawToolCalls, rawDispatchContext, toolRegistry, {
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
              buildToolUsage(responsePromptTokens, prepared.toolCalls),
              responsePromptTokens,
              glmStats,
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
        if (PROXY_DEBUG) {
          console.log("proxy_debug raw_tool_calls_blocked: true");
        }
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
          if (stream) {
            return deps.sendStreamContent(
              reply,
              finalContent,
              model,
              finalPayload.stats,
              finalPromptTokens,
              thinkingRef.value,
            );
          }
          return deps.sendContent(reply, finalContent, model, finalPromptTokens, finalPayload.stats);
        }
      }
      if (hasToolResult && responseText.trim()) {
        const extractedFinal = extractPlannerFinal(responseText);
        const finalContent = extractedFinal ?? responseText;
        if (stream) {
          return deps.sendStreamContent(
            reply,
            finalContent,
            model,
            glmStats,
            responsePromptTokens,
            thinkingRef.value,
          );
        }
        return deps.sendContent(reply, finalContent, model, responsePromptTokens, glmStats);
      }
      const fallbackTools = allowHeuristicTools
        ? inferReadToolCall(toolRegistry, lastUser) ||
          inferListToolCall(toolRegistry, lastUser) ||
          inferSearchToolCall(toolRegistry, lastUser)
        : null;
      if (fallbackTools) {
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
        );
      }
      if (!toolChoiceRequired) {
        const finalPayload = buildInstructionMessages(
          deps.contextConfig,
          "Answer the user directly. Return ONLY a JSON object matching the schema (actions empty, include final). No extra text or analysis.",
          messages,
          [],
        );
        const finalText = await collectModelResponse(activeChatId, finalPayload.messages);
        const finalPromptTokens = estimateMessagesTokens(finalPayload.messages);
        const finalContent = extractPlannerFinal(finalText) ?? finalText;
        if (stream) {
          return deps.sendStreamContent(
            reply,
            finalContent,
            model,
            finalPayload.stats,
            finalPromptTokens,
            thinkingRef.value,
          );
        }
        return deps.sendContent(reply, finalContent, model, finalPromptTokens, finalPayload.stats);
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
      const finalPayload = buildInstructionMessages(
        deps.contextConfig,
        "Tool loop limit reached. Use the tool results above to answer the user. Return ONLY a JSON object matching the schema (actions empty, include final). No extra text or analysis.",
        messages,
        [],
      );
      const finalText = await collectModelResponse(activeChatId, finalPayload.messages);
      const finalPromptTokens = estimateMessagesTokens(finalPayload.messages);
      const finalContent = extractPlannerFinal(finalText) ?? finalText;
      if (stream) {
        return deps.sendStreamContent(
          reply,
          finalContent,
          model,
          finalPayload.stats,
          finalPromptTokens,
          thinkingRef.value,
        );
      }
      return deps.sendContent(reply, finalContent, model, finalPromptTokens, finalPayload.stats);
    }

    if (parsedData.actions.length === 0) {
      if (hasToolResult && !String(parsedData.final || "").trim()) {
        return maybeRecoverEmptyActions({
          deps,
          ctx,
          activeChatId,
        });
      }
      if (!hasToolResult) {
        const fallbackTools = allowHeuristicTools
          ? inferReadToolCall(toolRegistry, lastUser) ||
            inferListToolCall(toolRegistry, lastUser) ||
            inferSearchToolCall(toolRegistry, lastUser)
          : null;
        if (fallbackTools) {
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
          );
        }
      }
      const content = parsedData.final || "";
      if (stream) {
        return deps.sendStreamContent(
          reply,
          content,
          model,
          glmStats,
          responsePromptTokens,
          thinkingRef.value,
        );
      }
      return deps.sendContent(reply, content, model, responsePromptTokens, glmStats);
    }

    const invalid = parsedData.actions.find((action: any) => !findTool(toolRegistry, action.tool));
    if (invalid) {
      const content = `Unknown tool: ${invalid.tool}`;
      if (stream) {
        return deps.sendStreamContent(reply, content, model, glmStats, responsePromptTokens);
      }
      return deps.sendContent(reply, content, model, responsePromptTokens, glmStats);
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
    );
  };

  return { handlePlannerFlow };
};

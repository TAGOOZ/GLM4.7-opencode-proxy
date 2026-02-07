import crypto from "crypto";
import { PROXY_DEBUG, PROXY_MAX_ACTIONS_PER_TURN } from "../constants.js";
import { filterPlannerActions } from "../tools/policy.js";
import { findTool, normalizeArgsForTool, type ToolInfo } from "../tools/registry.js";
import { inferRecentFilePath } from "../tools/path.js";
import { applyMutationActionBoundary } from "./guards.js";
import { isNoOpEditArgs } from "./utils.js";

export const limitPlannerActions = (parsedData: any) => {
  if (
    PROXY_MAX_ACTIONS_PER_TURN > 0 &&
    Array.isArray(parsedData.actions) &&
    parsedData.actions.length > PROXY_MAX_ACTIONS_PER_TURN
  ) {
    const originalCount = parsedData.actions.length;
    const trimmed = {
      ...parsedData,
      actions: parsedData.actions.slice(0, PROXY_MAX_ACTIONS_PER_TURN),
    };
    if (PROXY_DEBUG) {
      console.log(
        "proxy_debug too_many_actions: truncated_planner_actions",
        JSON.stringify({
          originalCount,
          returnedCount: trimmed.actions.length,
        }),
      );
    }
    return trimmed;
  }
  return parsedData;
};

export const filterPlannerActionsWithPolicy = (
  actions: any[],
  toolRegistry: Map<string, ToolInfo>,
  allowTodoWrite: boolean,
) => {
  if (!Array.isArray(actions) || actions.length === 0) return actions;
  const beforePolicy = actions.length;
  const policyFiltered = filterPlannerActions(actions as any[], {
    allowTodoTools: allowTodoWrite,
  });
  const candidateActions = policyFiltered.actions;
  const filteredTodoCount = policyFiltered.droppedTodoActions;
  let filteredNoOpCount = 0;
  const filtered = candidateActions.filter((action: any) => {
    const toolInfo = findTool(toolRegistry, action?.tool || "");
    const toolName = toolInfo?.tool.function?.name || toolInfo?.tool.name || action?.tool || "";
    const args =
      action?.args && typeof action.args === "object"
        ? (action.args as Record<string, unknown>)
        : {};
    const keep = !isNoOpEditArgs(toolName, args);
    if (!keep) filteredNoOpCount += 1;
    return keep;
  });
  if ((filteredTodoCount > 0 || filteredNoOpCount > 0) && PROXY_DEBUG) {
    console.log(
      "proxy_debug planner_actions_filtered:",
      JSON.stringify({
        originalCount: beforePolicy,
        filteredCount: filtered.length,
        droppedTodoActions: filteredTodoCount,
        droppedNoOpEdits: filteredNoOpCount,
      }),
    );
  }
  return filtered;
};

export const buildPlannerToolCalls = (params: {
  actions: any[];
  toolRegistry: Map<string, ToolInfo>;
  sanitizedMessages: any[];
}) => {
  const { actions, toolRegistry, sanitizedMessages } = params;
  const boundedActions = applyMutationActionBoundary(actions as any, toolRegistry);
  if (boundedActions.truncated && PROXY_DEBUG) {
    console.log(
      "proxy_debug mutation_action_boundary: truncated_planner_actions",
      JSON.stringify({
        originalCount: actions.length,
        returnedCount: boundedActions.actions.length,
        firstTool: actions[0]?.tool || "",
      }),
    );
  }

  const toolCalls = boundedActions.actions.map((action, idx) => {
    const toolInfo = findTool(toolRegistry, action.tool);
    const toolName = toolInfo?.tool.function?.name || toolInfo?.tool.name || action.tool;
    let args = normalizeArgsForTool(toolInfo, action.args || {});

    // Repair common planner mistakes: missing path/filePath on read tools.
    // Never infer a target path for mutation tools (no heuristic mutations).
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

  return { toolCalls };
};

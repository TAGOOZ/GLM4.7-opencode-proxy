import { PROXY_ALLOW_RAW_MUTATIONS } from "../constants.js";
import { findTool, type ToolInfo } from "../tools/registry.js";

const MUTATION_TOOLS = new Set([
  "write",
  "write_file",
  "apply_patch",
  "patch",
  "edit",
  "run",
  "run_shell",
  "bash",
  "shell",
  "delete",
  "remove",
  "mkdir",
  "move",
  "mv",
]);

const RAW_TOOL_ALLOWLIST = new Set([
  // Safe/non-mutating OpenCode tools that models often emit as raw tool_calls arrays.
  // We still run validateToolCalls() after parsing; this list is just the early gate.
  "question",
  "read",
  "read_file",
  "list",
  "list_dir",
  "glob",
  "grep",
  "task",
  "search",
  "rg",
  "ripgrep",
  "todoread",
  "todowrite",
  "webfetch",
  "websearch",
]);

export const normalizeToolName = (value: unknown) =>
  String(value || "").toLowerCase().replace(/[_-]/g, "");

export const MUTATION_TOOLS_NORM = new Set([...MUTATION_TOOLS].map((t) => normalizeToolName(t)));
const RAW_TOOL_ALLOWLIST_NORM = new Set([...RAW_TOOL_ALLOWLIST].map((t) => normalizeToolName(t)));

export const isRawToolCallsAllowed = (calls: any[]): boolean => {
  return calls.every((call) => {
    const toolName = normalizeToolName(call?.function?.name || call?.name || "");
    if (!toolName) return false;
    if (PROXY_ALLOW_RAW_MUTATIONS) return true;
    if (MUTATION_TOOLS_NORM.has(toolName)) return false;
    // Keep the legacy allowlist as a soft signal for debug/compat, but do not hard-block
    // unknown non-mutation tool names at this early stage.
    return true;
  });
};

const isMutationPlannerAction = (
  action: { tool: string },
  registry: Map<string, ToolInfo>,
): boolean => {
  const rawName = normalizeToolName(action?.tool || "");
  if (MUTATION_TOOLS_NORM.has(rawName)) return true;
  const toolInfo = findTool(registry, action?.tool || "");
  const resolvedName = normalizeToolName(
    toolInfo?.tool?.function?.name || toolInfo?.tool?.name || "",
  );
  return MUTATION_TOOLS_NORM.has(resolvedName);
};

export const applyMutationActionBoundary = (
  actions: { tool: string; args: Record<string, unknown> }[],
  registry: Map<string, ToolInfo>,
): { actions: { tool: string; args: Record<string, unknown> }[]; truncated: boolean } => {
  if (actions.length <= 1) return { actions, truncated: false };
  const bounded: { tool: string; args: Record<string, unknown> }[] = [];
  let mutationCount = 0;
  for (const action of actions) {
    const isMutation = isMutationPlannerAction(action, registry);
    if (isMutation) {
      mutationCount += 1;
      if (mutationCount > 1) {
        return { actions: bounded, truncated: true };
      }
    }
    bounded.push(action);
  }
  return { actions: bounded, truncated: false };
};

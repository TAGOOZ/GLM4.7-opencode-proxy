import type { ToolLike } from "./registry.js";

const TODO_INTENT_REGEX = /\b(todo|to-do|checklist|task list)\b/i;
const TODO_TOOL_NAMES = new Set(["todowrite", "todoread"]);

const normalizeToolName = (value: unknown): string =>
  String(value || "").toLowerCase().replace(/[_-]/g, "");

const extractToolName = (tool: ToolLike | null | undefined): string =>
  String(tool?.function?.name || tool?.name || "");

const isTodoToolName = (name: string): boolean => TODO_TOOL_NAMES.has(normalizeToolName(name));

const isTodoTool = (tool: ToolLike | null | undefined): boolean => isTodoToolName(extractToolName(tool));

const shouldAllowTodoTools = (userText: string): boolean => TODO_INTENT_REGEX.test(userText || "");

const filterPlannerTools = (
  tools: ToolLike[],
  options: { allowTodoTools: boolean },
): { tools: ToolLike[]; droppedTodoTools: string[] } => {
  if (options.allowTodoTools) {
    return { tools: [...tools], droppedTodoTools: [] };
  }
  const kept: ToolLike[] = [];
  const droppedTodoTools: string[] = [];
  for (const tool of tools) {
    const name = extractToolName(tool);
    if (isTodoToolName(name)) {
      droppedTodoTools.push(name || "tool");
      continue;
    }
    kept.push(tool);
  }
  return { tools: kept, droppedTodoTools };
};

const filterPlannerActions = (
  actions: any[],
  options: { allowTodoTools: boolean },
): { actions: any[]; droppedTodoActions: number } => {
  if (!Array.isArray(actions) || actions.length === 0 || options.allowTodoTools) {
    return { actions: Array.isArray(actions) ? actions : [], droppedTodoActions: 0 };
  }
  const filtered = actions.filter((action) => !isTodoToolName(String(action?.tool || "")));
  return {
    actions: filtered,
    droppedTodoActions: actions.length - filtered.length,
  };
};

export {
  filterPlannerActions,
  filterPlannerTools,
  isTodoTool,
  isTodoToolName,
  shouldAllowTodoTools,
};

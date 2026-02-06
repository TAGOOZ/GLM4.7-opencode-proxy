import crypto from "crypto";
import { findTool, normalizeArgsForTool, type ToolInfo } from "./registry.js";
import { pickArgKey } from "./inferUtils.js";

const extractPatchBlock = (text: string): string | null => {
  const fenced = text.match(/```(?:diff|patch)?\n([\s\S]+?)```/i);
  if (fenced && fenced[1]) {
    const block = fenced[1].trim();
    if (/^\s*(\*\*\* Begin Patch|diff --git)/m.test(block)) {
      return block;
    }
  }
  const beginMatch = /\*\*\* Begin Patch/.exec(text);
  const endMatch = /\*\*\* End Patch/.exec(text);
  if (beginMatch && endMatch && endMatch.index > beginMatch.index) {
    return text.slice(beginMatch.index, endMatch.index + "*** End Patch".length).trim();
  }
  return null;
};

const parsePatchForEdit = (patch: string): { filePath: string; oldString: string; newString: string } | null => {
  const fileMatch =
    patch.match(/^\s*\*\*\*\s+Update File:\s*(.+)$/m) ||
    patch.match(/^\s*\+\+\+\s+b\/(.+)$/m) ||
    patch.match(/^\s*diff --git a\/.+ b\/(.+)$/m);
  if (!fileMatch) return null;
  const filePath = fileMatch[1]?.trim();
  if (!filePath) return null;
  const lines = patch.split(/\r?\n/);
  let inHunk = false;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (trimmed.startsWith("*** End Patch")) break;
    if (trimmed.startsWith("---") || trimmed.startsWith("+++")) continue;
    if (trimmed.startsWith("-")) {
      oldLines.push(trimmed.slice(1));
      continue;
    }
    if (trimmed.startsWith("+")) {
      newLines.push(trimmed.slice(1));
      continue;
    }
  }
  if (!oldLines.length || !newLines.length) return null;
  return { filePath, oldString: oldLines.join("\n"), newString: newLines.join("\n") };
};

const inferApplyPatchToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const patch = extractPatchBlock(userText);
  if (!patch) return null;
  const toolInfo = findTool(registry, "apply_patch");
  if (!toolInfo) return null;
  const key = pickArgKey(toolInfo, ["patch", "input", "diff", "changes"]);
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "apply_patch";
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify({ [key]: patch }) },
    },
  ];
};

const inferEditToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const patch = extractPatchBlock(userText);
  if (!patch) return null;
  const toolInfo = findTool(registry, "edit") || findTool(registry, "edit_file");
  if (!toolInfo) return null;
  const parsed = parsePatchForEdit(patch);
  if (!parsed) return null;
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "edit";
  const args = {
    filePath: parsed.filePath,
    oldString: parsed.oldString,
    newString: parsed.newString,
  };
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify(normalizeArgsForTool(toolInfo, args)) },
    },
  ];
};

export { inferApplyPatchToolCall, inferEditToolCall };


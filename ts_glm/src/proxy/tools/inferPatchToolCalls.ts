import { findTool, normalizeArgsForTool, type ToolInfo } from "./registry.js";
import { buildSingleToolCall, pickArgKey } from "./inferUtils.js";

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

const extractSingleTargetPath = (patch: string): string | null => {
  const paths: string[] = [];
  const addPath = (value: string | undefined) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return;
    paths.push(trimmed);
  };

  for (const match of patch.matchAll(/^\s*\*\*\*\s+Update File:\s*(.+)$/gm)) addPath(match[1]);
  if (!paths.length) {
    for (const match of patch.matchAll(/^\s*diff --git a\/.+ b\/(.+)$/gm)) addPath(match[1]);
  }
  if (!paths.length) {
    for (const match of patch.matchAll(/^\s*\+\+\+\s+b\/(.+)$/gm)) addPath(match[1]);
  }

  const unique = [...new Set(paths)];
  if (unique.length !== 1) return null;
  return unique[0];
};

const parsePatchForEdit = (patch: string): { filePath: string; oldString: string; newString: string } | null => {
  const filePath = extractSingleTargetPath(patch);
  if (!filePath) return null;

  const lines = patch.split(/\r?\n/);
  let inHunk = false;
  let hunkCount = 0;
  let hasChange = false;
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@@")) {
      hunkCount += 1;
      if (hunkCount > 1) return null;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (
      line.startsWith("*** End Patch") ||
      line.startsWith("*** Update File:") ||
      line.startsWith("*** Add File:") ||
      line.startsWith("*** Delete File:") ||
      line.startsWith("diff --git ")
    ) {
      break;
    }
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("---") || line.startsWith("+++")) continue;

    const marker = line.slice(0, 1);
    const content = line.slice(1);
    if (marker === "-") {
      hasChange = true;
      oldLines.push(content);
      continue;
    }
    if (marker === "+") {
      hasChange = true;
      newLines.push(content);
      continue;
    }
    if (marker === " ") {
      oldLines.push(content);
      newLines.push(content);
      continue;
    }
  }

  if (hunkCount !== 1 || !hasChange) return null;
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
  return buildSingleToolCall(toolName, { [key]: patch });
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
  return buildSingleToolCall(toolName, normalizeArgsForTool(toolInfo, args));
};

export { inferApplyPatchToolCall, inferEditToolCall };

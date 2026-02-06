import crypto from "crypto";
import { findTool, type ToolInfo } from "./registry.js";
import { isSensitivePath } from "./pathSafety.js";
import { extractDirPath, extractFilePath, pickArgKey } from "./inferUtils.js";

const inferReadToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const lowered = userText.toLowerCase();
  const path = extractFilePath(userText);
  const hasSearchIntent = /\b(search|find)\b/.test(lowered);
  const hasReadVerb = /\b(read|open|show|cat|print|display)\b/.test(lowered);
  const hasReadIntent = hasReadVerb || hasSearchIntent;
  const hasRunTool = Boolean(findTool(registry, "run") || findTool(registry, "run_shell"));
  if (!hasReadIntent) return null;
  if (hasSearchIntent && hasRunTool) return null;
  if (/\b(directory|folder|dir)\b/.test(lowered) && path && !/\.[A-Za-z0-9]{1,10}$/.test(path)) {
    return null;
  }
  const toolInfo = findTool(registry, "read");
  if (!toolInfo) return null;
  if (!path) return null;
  if (isSensitivePath(path)) return null;
  const key = pickArgKey(toolInfo, ["filePath", "path"]);
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "read";
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify({ [key]: path }) },
    },
  ];
};

const inferWriteToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const toolInfo = findTool(registry, "write");
  if (!toolInfo) return null;
  const patterns = [
    /create (?:a )?file\s+([\w./-]+)\s+with content\s+([\s\S]+)/i,
    /create (?:a )?file\s+([\w./-]+)\s+with\s+([\s\S]+)/i,
    /write\s+([\s\S]+?)\s+to\s+([\w./-]+)/i,
    /save\s+([\w./-]+)\s+content\s+([\s\S]+)/i,
  ];
  for (const pattern of patterns) {
    const match = userText.match(pattern);
    if (!match) continue;
    let filePath = match[1];
    let content = match[2];
    if (pattern === patterns[2]) {
      filePath = match[2];
      content = match[1];
    }
    filePath = filePath.replace(/^[\"'`]/, "").replace(/[\"'`].*$/, "");
    content = content.replace(/^[\"'`]/, "").replace(/[\"'`]$/, "");
    if (!filePath || !content) continue;
    const pathKey = pickArgKey(toolInfo, ["filePath", "path"]);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "write";
    return [
      {
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        index: 0,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify({ [pathKey]: filePath, content }) },
      },
    ];
  }
  // Fallback: "create file X" without content -> use placeholder
  const simple = userText.match(/create (?:a )?file\s+([\w./-]+)/i);
  if (simple && simple[1]) {
    const filePath = simple[1];
    const pathKey = pickArgKey(toolInfo, ["filePath", "path"]);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "write";
    return [
      {
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        index: 0,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify({ [pathKey]: filePath, content: "" }) },
      },
    ];
  }
  return null;
};

const inferListToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const lowered = userText.toLowerCase();
  const listIntent = ["list files", "list folders", "list directory", "show files", "inspect files"];
  const dirIntent = [
    "directory contents",
    "folder contents",
    "contents of",
    "what is in",
    "what's in",
    "read directory",
    "read dir",
    "show directory",
    "show folder",
  ];
  const hasLsToken = /\bls\b/.test(lowered);
  if (!hasLsToken && !listIntent.some((k) => lowered.includes(k)) && !dirIntent.some((k) => lowered.includes(k))) {
    return null;
  }
  const toolInfo = findTool(registry, "glob") || findTool(registry, "list");
  if (!toolInfo) return null;
  const key = pickArgKey(toolInfo, ["pattern", "path"]);
  const dirPath = extractDirPath(userText) || ".";
  const pattern = dirPath === "." || dirPath === "./" ? "**/*" : `${dirPath.replace(/\/$/, "")}/**/*`;
  const args = key === "pattern" ? { [key]: pattern } : { [key]: dirPath };
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolInfo.tool.function?.name || toolInfo.tool.name || "glob", arguments: JSON.stringify(args) },
    },
  ];
};

export { inferListToolCall, inferReadToolCall, inferWriteToolCall };


import crypto from "crypto";
import { findTool, normalizeArgsForTool, type ToolInfo } from "./registry.js";
import { parseRawJson } from "./parse.js";
import { extractKeyValueArgs, pickArgKey } from "./inferUtils.js";

const inferExplicitToolCalls = (registry: Map<string, ToolInfo>, userText: string) => {
  const lines = userText.split(/\r?\n/);
  const toolCalls = [];
  for (const line of lines) {
    const match = line.match(/^\s*%\s*([A-Za-z0-9_.:-]+)\s*[:\\-]?\s*(.*)$/);
    if (!match) continue;
    const rawName = match[1];
    const rest = (match[2] || "").trim();
    const toolInfo = findTool(registry, rawName);
    if (!toolInfo) continue;
    let args: Record<string, unknown> = {};
    if (rest) {
      const parsed = parseRawJson(rest);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        const kvArgs = extractKeyValueArgs(rest);
        if (kvArgs) {
          args = kvArgs;
        } else {
          const key = pickArgKey(toolInfo, [
            "url",
            "uri",
            "path",
            "filePath",
            "query",
            "input",
            "text",
            "command",
            "cmd",
            "pattern",
          ]);
          args = { [key]: rest };
        }
      }
    }
    args = normalizeArgsForTool(toolInfo, args);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || rawName;
    toolCalls.push({
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: toolCalls.length,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify(args) },
    });
  }
  return toolCalls.length ? toolCalls : null;
};

export { inferExplicitToolCalls };


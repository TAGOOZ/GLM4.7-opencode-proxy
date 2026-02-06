import crypto from "crypto";
import { findTool, normalizeArgsForTool, type ToolInfo } from "./registry.js";
import {
  extractJsonBlock,
  findStringEnd,
  normalizeJsonCandidate,
  parseRawJson,
} from "./parseJson.js";

const parseArgsBlock = (block: string | null): Record<string, unknown> | null => {
  if (!block) return null;
  try {
    const normalized = normalizeJsonCandidate(block);
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
};

const extractArgumentsFromFunctionText = (text: string): Record<string, unknown> => {
  const key = "\"arguments\"";
  const idx = text.indexOf(key);
  if (idx === -1) return {};
  let pos = idx + key.length;
  while (pos < text.length && text[pos] !== ":") pos += 1;
  if (pos >= text.length) return {};
  pos += 1;
  while (pos < text.length && /\s/.test(text[pos])) pos += 1;
  if (pos >= text.length) return {};
  const ch = text[pos];
  if (ch === "{") {
    const block = extractJsonBlock(text.slice(pos), "{", "}");
    return parseArgsBlock(block) ?? {};
  }
  if (ch === "\"") {
    const end = findStringEnd(text, pos);
    if (end === -1) return {};
    const rawString = text.slice(pos + 1, end);
    const trimmed = rawString.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = parseArgsBlock(trimmed);
      if (parsed) return parsed;
    }
    try {
      const escaped = rawString.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
      const decoded = JSON.parse(`"${escaped}"`);
      const maybeJson = String(decoded).trim();
      if (maybeJson.startsWith("{") || maybeJson.startsWith("[")) {
        const parsed = parseArgsBlock(maybeJson);
        if (parsed) return parsed;
      }
    } catch {
      // ignore
    }
  }
  return {};
};

const parseToolCallsFromText = (raw: string, registry: Map<string, ToolInfo>) => {
  const toolCalls = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const idx = raw.indexOf("\"function\"", cursor);
    if (idx === -1) break;
    const braceIdx = raw.indexOf("{", idx);
    if (braceIdx === -1) {
      cursor = idx + 10;
      continue;
    }
    const block = extractJsonBlock(raw.slice(braceIdx), "{", "}");
    if (!block) {
      cursor = braceIdx + 1;
      continue;
    }
    const nameMatch = block.match(/"name"\s*:\s*"([^"]+)"/);
    if (!nameMatch) {
      cursor = braceIdx + block.length;
      continue;
    }
    const rawName = nameMatch[1];
    const toolInfo = findTool(registry, rawName);
    if (!toolInfo) {
      cursor = braceIdx + block.length;
      continue;
    }
    const args = extractArgumentsFromFunctionText(block);
    const normalizedArgs = normalizeArgsForTool(toolInfo, args);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || rawName;
    toolCalls.push({
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: toolCalls.length,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(normalizedArgs),
      },
    });
    cursor = braceIdx + block.length;
  }
  return toolCalls.length ? toolCalls : null;
};

const parseRawToolCalls = (raw: string, registry: Map<string, ToolInfo>) => {
  const data = parseRawJson(raw);
  if (!data) {
    return parseToolCallsFromText(raw, registry);
  }
  let calls: any[] = [];
  if (Array.isArray(data)) {
    calls = data;
  } else if (Array.isArray(data.tool_calls)) {
    calls = data.tool_calls;
  } else if (data.tool && data.arguments !== undefined) {
    calls = [{ tool: data.tool, arguments: data.arguments }];
  } else if (data.function || data.name) {
    calls = [data];
  } else {
    return null;
  }

  const toolCalls = [];
  for (const call of calls) {
    const func = call.function || call;
    const rawName = func?.name || call.name || call.tool;
    if (!rawName) continue;
    const toolInfo = findTool(registry, rawName);
    if (!toolInfo) continue;
    let args = func?.arguments ?? call.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        const reparsed = parseRawJson(args);
        if (reparsed && typeof reparsed === "object") {
          args = reparsed;
        } else {
          args = {};
        }
      }
    }
    if (!args || typeof args !== "object") {
      args = {};
    }
    args = normalizeArgsForTool(toolInfo, args as Record<string, unknown>);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || rawName;
    toolCalls.push({
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: toolCalls.length,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(args),
      },
    });
  }
  return toolCalls.length ? toolCalls : null;
};

export { parseRawToolCalls };

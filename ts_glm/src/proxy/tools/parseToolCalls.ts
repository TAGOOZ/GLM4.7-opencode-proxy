import crypto from "crypto";
import { findTool, normalizeArgsForTool, type ToolInfo } from "./registry.js";
import {
  extractJsonBlock,
  findStringEnd,
  normalizeJsonCandidate,
  parseRawJson,
} from "./parseJson.js";

const asPlainObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const parseArgsBlock = (block: string | null): Record<string, unknown> | null => {
  if (!block) return null;
  try {
    const normalized = normalizeJsonCandidate(block);
    const parsed = JSON.parse(normalized);
    const obj = asPlainObject(parsed);
    if (obj) return obj;
  } catch {
    // ignore
  }
  return null;
};

const parseArgsString = (raw: string): Record<string, unknown> | null => {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return {};

  const direct = parseArgsBlock(trimmed);
  if (direct) return direct;

  try {
    const decoded = JSON.parse(trimmed);
    const obj = asPlainObject(decoded);
    if (obj) return obj;
    if (typeof decoded === "string") {
      const nested = parseArgsBlock(decoded);
      if (nested) return nested;
    }
  } catch {
    // ignore
  }

  const reparsed = parseRawJson(trimmed);
  const reparsedObj = asPlainObject(reparsed);
  if (reparsedObj) return reparsedObj;

  const objectBlock = extractJsonBlock(trimmed, "{", "}");
  if (objectBlock) {
    const blockParsed = parseArgsBlock(objectBlock);
    if (blockParsed) return blockParsed;
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
    const parsedRaw = parseArgsString(rawString);
    if (parsedRaw) return parsedRaw;
    try {
      const decoded = JSON.parse(`"${rawString}"`);
      const parsedDecoded = parseArgsString(String(decoded));
      if (parsedDecoded) return parsedDecoded;
    } catch {
      try {
        const escaped = rawString.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
        const decoded = JSON.parse(`"${escaped}"`);
        const parsedDecoded = parseArgsString(String(decoded));
        if (parsedDecoded) return parsedDecoded;
      } catch {
        // ignore
      }
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
    const rawArgs = func?.arguments ?? call.arguments ?? {};
    let serializedArgs = "{}";
    if (typeof rawArgs === "string") {
      const parsedArgs = parseArgsString(rawArgs);
      if (parsedArgs) {
        const normalizedArgs = normalizeArgsForTool(toolInfo, parsedArgs);
        serializedArgs = JSON.stringify(normalizedArgs);
      } else {
        // Preserve malformed raw arguments so guard validation can block explicitly
        // instead of silently coercing to {} and replaying invalid calls.
        serializedArgs = rawArgs;
      }
    } else if (asPlainObject(rawArgs)) {
      const normalizedArgs = normalizeArgsForTool(toolInfo, rawArgs as Record<string, unknown>);
      serializedArgs = JSON.stringify(normalizedArgs);
    }
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || rawName;
    toolCalls.push({
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: toolCalls.length,
      type: "function",
      function: {
        name: toolName,
        arguments: serializedArgs,
      },
    });
  }
  return toolCalls.length ? toolCalls : null;
};

export { parseRawToolCalls };

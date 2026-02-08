import crypto from "crypto";
import { findTool, normalizeArgsForTool, type ToolInfo } from "./registry.js";
import {
  asPlainObject,
  extractJsonBlock,
  findStringEnd,
  normalizeJsonCandidate,
  parseRawJson,
  selectJsonEnvelope,
} from "./parseJson.js";

const createFunctionToolCall = (toolName: string, serializedArgs: string, index: number) => ({
  id: `call_${crypto.randomUUID().slice(0, 8)}`,
  index,
  type: "function",
  function: {
    name: toolName,
    arguments: serializedArgs,
  },
});

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

  const parseStrictObjectCandidate = (candidate: string): Record<string, unknown> | null => {
    const normalizedCandidate = String(candidate || "").trim();
    if (!normalizedCandidate) return {};
    const direct = parseArgsBlock(normalizedCandidate);
    if (direct) return direct;
    const envelope = selectJsonEnvelope(normalizedCandidate);
    if (!envelope || !envelope.startsWith("{")) return null;
    return parseArgsBlock(envelope);
  };

  const direct = parseStrictObjectCandidate(trimmed);
  if (direct) return direct;

  try {
    const decoded = JSON.parse(trimmed);
    const obj = asPlainObject(decoded);
    if (obj) return obj;
    if (typeof decoded === "string") {
      const nested = parseStrictObjectCandidate(decoded);
      if (nested) return nested;
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
    if (!/"arguments"\s*:/.test(block)) {
      cursor = braceIdx + block.length;
      continue;
    }
    const args = extractArgumentsFromFunctionText(block);
    const normalizedArgs = normalizeArgsForTool(toolInfo, args);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || rawName;
    toolCalls.push(createFunctionToolCall(toolName, JSON.stringify(normalizedArgs), toolCalls.length));
    cursor = braceIdx + block.length;
  }
  return toolCalls.length ? toolCalls : null;
};

const hasOwn = (value: unknown, key: string): boolean =>
  Boolean(value) && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);

const isToolCallCandidate = (value: unknown): boolean => {
  const obj = asPlainObject(value);
  if (!obj) return false;
  const func = asPlainObject(obj.function);
  if (func && typeof func.name === "string") {
    if (hasOwn(func, "arguments")) return true;
    return typeof obj.type === "string" || hasOwn(obj, "id");
  }
  if (typeof obj.tool === "string") return hasOwn(obj, "arguments");
  if (typeof obj.name === "string") return hasOwn(obj, "arguments");
  return false;
};

const stringifyUnknown = (value: unknown): string => {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") return serialized;
  } catch {
    // ignore
  }
  return String(value);
};

type ParseRawToolCallsOptions = {
  allowProseEnvelope?: boolean;
};

const parseRawToolCalls = (
  raw: string,
  registry: Map<string, ToolInfo>,
  options?: ParseRawToolCallsOptions,
) => {
  const allowProseEnvelope = options?.allowProseEnvelope ?? true;
  const envelope = selectJsonEnvelope(raw, { allowProse: allowProseEnvelope });
  if (!envelope) return null;

  const data = parseRawJson(envelope);
  if (!data) {
    return parseToolCallsFromText(envelope, registry);
  }
  let calls: any[] = [];
  if (Array.isArray(data)) {
    calls = data;
  } else if (Array.isArray(data.tool_calls)) {
    calls = data.tool_calls;
  } else if (data.tool && data.arguments !== undefined) {
    calls = [{ tool: data.tool, arguments: data.arguments }];
  } else if (isToolCallCandidate(data)) {
    calls = [data];
  } else {
    return null;
  }

  const toolCalls = [];
  for (const call of calls) {
    if (!isToolCallCandidate(call)) continue;
    const callObj = asPlainObject(call);
    if (!callObj) continue;
    const func = asPlainObject(callObj.function);
    const rawName =
      (func && typeof func.name === "string" ? func.name : "") ||
      (typeof callObj.name === "string" ? callObj.name : "") ||
      (typeof callObj.tool === "string" ? callObj.tool : "");
    if (!rawName) continue;
    const toolInfo = findTool(registry, rawName);
    if (!toolInfo) continue;
    const hasFunctionArgs = hasOwn(func, "arguments");
    const hasCallArgs = hasOwn(callObj, "arguments");
    const hasExplicitArgs = hasFunctionArgs || hasCallArgs;
    const rawArgs = hasFunctionArgs ? (func as any).arguments : hasCallArgs ? (callObj as any).arguments : {};
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
    } else if (hasExplicitArgs) {
      // Preserve non-object primitive/array arguments so guard validation can reject explicitly.
      serializedArgs = stringifyUnknown(rawArgs);
    }
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || rawName;
    toolCalls.push(createFunctionToolCall(toolName, serializedArgs, toolCalls.length));
  }
  return toolCalls.length ? toolCalls : null;
};

export { parseRawToolCalls };

import crypto from "crypto";
import {
  extractFirstJsonObject,
  parseModelOutput,
  repairPlannerJson,
  removeComments,
  removeTrailingCommas,
  validateModelOutput,
  type ModelOutput,
} from "web-wrapper-protocol";
import { findTool, normalizeArgsForTool, type ToolInfo } from "./registry.js";

const stripFences = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  return trimmed;
};

const extractJsonBlock = (text: string, openChar: string, closeChar: string): string | null => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === openChar) {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
};

const parseRawJson = (raw: string): any | null => {
  const cleaned = stripFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    const normalized = normalizeJsonCandidate(cleaned);
    if (normalized !== cleaned) {
      try {
        return JSON.parse(normalized);
      } catch {
        // continue
      }
    }
    // try arrays first (tool_calls often output as arrays)
    const arrayBlock = extractJsonBlock(cleaned, "[", "]");
    if (arrayBlock) {
      try {
        return JSON.parse(arrayBlock);
      } catch {
        const normalizedArray = normalizeJsonCandidate(arrayBlock);
        if (normalizedArray !== arrayBlock) {
          try {
            return JSON.parse(normalizedArray);
          } catch {
            // ignore
          }
        }
        // ignore
      }
    }
    const objectBlock = extractJsonBlock(cleaned, "{", "}");
    if (objectBlock) {
      try {
        return JSON.parse(objectBlock);
      } catch {
        const normalizedObject = normalizeJsonCandidate(objectBlock);
        if (normalizedObject !== objectBlock) {
          try {
            return JSON.parse(normalizedObject);
          } catch {
            // ignore
          }
        }
        // ignore
      }
    }
  }
  return null;
};

const repairUnescapedNewlines = (text: string): string => {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === "\"") {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === "\"") {
      inString = true;
    }
    out += ch;
  }
  return out;
};

const normalizeJsonCandidate = (text: string): string => {
  const newlineFixed = repairUnescapedNewlines(text);
  const argsFixed = repairArgumentsStrings(newlineFixed);
  const withoutComments = removeComments(argsFixed);
  const withoutTrailing = removeTrailingCommas(withoutComments);
  return withoutTrailing;
};

const findStringEnd = (text: string, start: number): number => {
  let escaped = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      return i;
    }
  }
  return -1;
};

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

const repairArgumentsStrings = (text: string): string => {
  let cursor = 0;
  let output = "";
  const key = "\"arguments\"";
  while (cursor < text.length) {
    const idx = text.indexOf(key, cursor);
    if (idx === -1) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, idx);
    output += key;
    let valueStart = idx + key.length;
    // copy until the opening quote of the value
    while (valueStart < text.length && text[valueStart] !== "\"") {
      output += text[valueStart];
      valueStart += 1;
    }
    if (valueStart >= text.length) {
      output += text.slice(idx + key.length);
      break;
    }
    output += "\"";
    const valueEnd = findStringEnd(text, valueStart);
    if (valueEnd === -1) {
      output += text.slice(valueStart + 1);
      break;
    }
    const rawValue = text.slice(valueStart + 1, valueEnd);
    const fixedValue = rawValue.replace(/\r?\n/g, "\\n");
    output += fixedValue;
    output += "\"";
    cursor = valueEnd + 1;
  }
  return output;
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

const coercePlannerData = (data: any): ModelOutput => {
  const plan = Array.isArray(data?.plan)
    ? data.plan.map((p: any) => String(p))
    : typeof data?.plan === "string"
      ? [data.plan]
      : [];
  const rawActions = Array.isArray(data?.actions)
    ? data.actions
    : data?.actions
      ? [data.actions]
      : [];
  const actions = rawActions.map((action: any) => {
    const safety = action?.safety && typeof action.safety === "object" ? action.safety : {};
    const risk =
      safety.risk === "medium" || safety.risk === "high" || safety.risk === "low" ? safety.risk : "low";
    return {
      tool: typeof action?.tool === "string" ? action.tool : "",
      args: action?.args && typeof action.args === "object" ? action.args : {},
      why: typeof action?.why === "string" ? action.why : "",
      expect: typeof action?.expect === "string" ? action.expect : "",
      safety: {
        risk,
        notes: typeof safety.notes === "string" ? safety.notes : "",
      },
    };
  });
  const output: ModelOutput = { plan, actions };
  if (actions.length === 0) {
    output.final = typeof data?.final === "string" ? data.final : "";
  }
  if (typeof data?.thought === "string") {
    output.thought = data.thought;
  }
  return output;
};

const tryRepairPlannerOutput = (raw: string): ModelOutput | null => {
  const extracted = extractFirstJsonObject(raw);
  if (!extracted.json) return null;
  const repaired = repairPlannerJson(extracted.json);
  let parsed: any;
  try {
    parsed = JSON.parse(repaired);
  } catch {
    return null;
  }
  const coerced = coercePlannerData(parsed);
  const validation = validateModelOutput(coerced);
  if (!validation.ok) return null;
  return coerced;
};

const tryParseModelOutput = (raw: string, allowRelaxed: boolean) => {
  let parsed = parseModelOutput(raw, true);
  if (!parsed.ok && allowRelaxed) {
    const relaxed = parseModelOutput(raw, false);
    if (relaxed.ok) {
      parsed = relaxed;
    }
  }
  return parsed;
};

export {
  extractJsonBlock,
  parseRawJson,
  parseRawToolCalls,
  stripFences,
  tryParseModelOutput,
  tryRepairPlannerOutput,
};

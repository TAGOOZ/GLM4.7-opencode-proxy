import crypto from "crypto";
import {
  extractFirstJsonObject,
  parseModelOutput,
  repairPlannerJson,
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
    // try arrays first (tool_calls often output as arrays)
    const arrayBlock = extractJsonBlock(cleaned, "[", "]");
    if (arrayBlock) {
      try {
        return JSON.parse(arrayBlock);
      } catch {
        // ignore
      }
    }
    const objectBlock = extractJsonBlock(cleaned, "{", "}");
    if (objectBlock) {
      try {
        return JSON.parse(objectBlock);
      } catch {
        // ignore
      }
    }
  }
  return null;
};

const parseRawToolCalls = (raw: string, registry: Map<string, ToolInfo>) => {
  const data = parseRawJson(raw);
  if (!data) return null;
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
        args = {};
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

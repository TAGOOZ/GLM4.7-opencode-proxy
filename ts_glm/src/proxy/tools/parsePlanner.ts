import {
  extractFirstJsonObject,
  parseModelOutput,
  repairPlannerJson,
  validateModelOutput,
  type ModelOutput,
} from "web-wrapper-protocol";
import { extractJsonBlock, parseRawJson } from "./parseJson.js";

const EXAMPLE_CONTEXT_REGEX =
  /\b(example|schema|shape|template|sample|illustrative|for reference|do not execute|don't execute|not a call)\b/i;

const asPlainObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const parseActionArgs = (value: unknown): Record<string, unknown> | null => {
  const direct = asPlainObject(value);
  if (direct) return direct;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = parseRawJson(value);
  return asPlainObject(parsed);
};

// Some models respond with an OpenAI-style tool-call array embedded in a markdown fence:
// ```json
// [{ "type":"function", "function": { "name":"final", "arguments":"{\"text\":\"...\"}" } }]
// ```
// This is not our planner schema, but it is a valid "final answer". Treat it as final.
const tryParseOpenAIStyleFinal = (raw: string): ModelOutput | null => {
  const parsed = parseRawJson(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const first = asPlainObject(parsed[0]);
  if (!first) return null;
  const fn = asPlainObject(first.function);
  const name = typeof fn?.name === "string" ? fn.name.trim() : "";
  if (name !== "final") return null;

  const args = parseActionArgs(fn?.arguments);
  const text = typeof args?.text === "string" && args.text ? args.text : null;
  if (!text) return null;

  const output: ModelOutput = { plan: [], actions: [], final: text };
  const validation = validateModelOutput(output);
  if (!validation.ok) return null;
  return output;
};

const coercePlannerAction = (action: unknown): ModelOutput["actions"][number] | null => {
  const actionObj = asPlainObject(action);
  if (!actionObj) return null;

  const functionObj = asPlainObject(actionObj.function);
  const rawTool =
    (typeof actionObj.tool === "string" && actionObj.tool.trim() ? actionObj.tool.trim() : "") ||
    (typeof actionObj.name === "string" && actionObj.name.trim() ? actionObj.name.trim() : "") ||
    (typeof functionObj?.name === "string" && functionObj.name.trim() ? functionObj.name.trim() : "");
  if (!rawTool) return null;

  const args =
    parseActionArgs(actionObj.args) ||
    parseActionArgs(actionObj.arguments) ||
    parseActionArgs(functionObj?.arguments);
  if (!args) return null;

  const safety = asPlainObject(actionObj.safety) || {};
  const risk =
    safety.risk === "medium" || safety.risk === "high" || safety.risk === "low" ? safety.risk : "low";
  return {
    tool: rawTool,
    args,
    why: typeof actionObj.why === "string" ? actionObj.why : "",
    expect: typeof actionObj.expect === "string" ? actionObj.expect : "",
    safety: {
      risk,
      notes: typeof safety.notes === "string" ? safety.notes : "",
    },
  };
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
  const actions = rawActions
    .map((action: any) => coercePlannerAction(action))
    .filter(Boolean) as ModelOutput["actions"];
  const output: ModelOutput = { plan, actions };
  if (actions.length === 0) {
    output.final = typeof data?.final === "string" ? data.final : "";
  }
  if (typeof data?.thought === "string") {
    output.thought = data.thought;
  }
  return output;
};

const salvagePlannerActionsFromMalformedText = (raw: string): ModelOutput | null => {
  const text = String(raw || "");
  if (!/"actions"\s*:/.test(text) || !/"plan"\s*:|\"final\"\s*:/.test(text)) {
    return null;
  }
  const trimmed = text.trimStart();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("```"))) {
    return null;
  }
  const contextPreview = trimmed.slice(0, 320);
  if (EXAMPLE_CONTEXT_REGEX.test(contextPreview)) {
    return null;
  }

  const actionsAnchor = text.lastIndexOf("\"actions\"");
  if (actionsAnchor === -1) {
    return null;
  }
  const arrayStart = text.indexOf("[", actionsAnchor);
  if (arrayStart === -1) {
    return null;
  }

  const actions: ModelOutput["actions"] = [];
  let cursor = arrayStart + 1;

  while (cursor < text.length && actions.length < 8) {
    const tail = text.slice(cursor);
    const closeMatch = tail.match(/^\s*\]/);
    if (closeMatch) break;

    const actionStart = text.indexOf("{", cursor);
    if (actionStart === -1) break;
    const actionBlock = extractJsonBlock(text.slice(actionStart), "{", "}");
    if (!actionBlock) break;

    const parsedAction = parseRawJson(actionBlock);
    const coerced = coercePlannerAction(parsedAction);
    if (coerced) actions.push(coerced);

    cursor = actionStart + actionBlock.length;
  }

  if (actions.length === 0) {
    return null;
  }
  return { plan: [], actions };
};

const extractLikelyJsonObjects = (raw: string): string[] => {
  const text = String(raw || "");
  const out: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  const startsLikeJsonObject = (index: number): boolean => {
    let probe = index + 1;
    while (probe < text.length && /\s/.test(text[probe])) probe += 1;
    if (probe >= text.length) return false;
    const next = text[probe];
    return next === "\"" || next === "}";
  };

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

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

    if (ch === "{") {
      if (depth === 0) {
        if (!startsLikeJsonObject(i)) continue;
        start = i;
      }
      if (start !== -1) depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start !== -1) {
        pushCandidate(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
};

const parseCandidateAsModelOutput = (candidate: string): ModelOutput | null => {
  const repaired = repairPlannerJson(candidate);
  let parsed: any;
  try {
    parsed = JSON.parse(repaired);
  } catch {
    const salvaged = salvagePlannerActionsFromMalformedText(repaired);
    if (salvaged) return salvaged;
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const hasPlannerKeys =
    Object.prototype.hasOwnProperty.call(parsed, "plan") ||
    Object.prototype.hasOwnProperty.call(parsed, "actions") ||
    Object.prototype.hasOwnProperty.call(parsed, "final") ||
    Object.prototype.hasOwnProperty.call(parsed, "thought");
  if (!hasPlannerKeys) return null;
  const coerced = coercePlannerData(parsed);
  const validation = validateModelOutput(coerced);
  if (!validation.ok) return null;
  return coerced;
};

const tryRepairPlannerOutput = (raw: string): ModelOutput | null => {
  const extracted = extractFirstJsonObject(raw);
  if (extracted.json) {
    const repaired = parseCandidateAsModelOutput(extracted.json);
    if (repaired) return repaired;
  }

  const candidates = extractLikelyJsonObjects(raw);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const recovered = parseCandidateAsModelOutput(candidates[i]);
    if (recovered) return recovered;
  }
  const salvaged = salvagePlannerActionsFromMalformedText(raw);
  if (salvaged) return salvaged;
  return null;
};

const tryParseModelOutput = (raw: string, allowRelaxed: boolean) => {
  const strictResult = parseModelOutput(raw, true);
  if (strictResult.ok) return strictResult;

  const openAiFinal = tryParseOpenAIStyleFinal(raw);
  if (openAiFinal) return { ok: true, data: openAiFinal };

  const candidates = extractLikelyJsonObjects(raw);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i];
    const strictCandidate = parseModelOutput(candidate, true);
    if (strictCandidate.ok) return strictCandidate;

    if (allowRelaxed) {
      const relaxedCandidate = parseModelOutput(candidate, false);
      if (relaxedCandidate.ok) return relaxedCandidate;
    }

    const repaired = parseCandidateAsModelOutput(candidate);
    if (repaired) {
      return { ok: true, data: repaired };
    }
  }

  if (allowRelaxed) {
    const relaxedResult = parseModelOutput(raw, false);
    if (relaxedResult.ok) {
      return relaxedResult;
    }
  }

  const salvaged = salvagePlannerActionsFromMalformedText(raw);
  if (salvaged) {
    return { ok: true, data: salvaged };
  }

  return strictResult;
};

export { tryParseModelOutput, tryRepairPlannerOutput };

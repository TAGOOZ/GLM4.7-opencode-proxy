import {
  extractFirstJsonObject,
  parseModelOutput,
  repairPlannerJson,
  validateModelOutput,
  type ModelOutput,
} from "web-wrapper-protocol";
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
  return null;
};

const tryParseModelOutput = (raw: string, allowRelaxed: boolean) => {
  const strictResult = parseModelOutput(raw, true);
  if (strictResult.ok) return strictResult;

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

  return strictResult;
};

export { tryParseModelOutput, tryRepairPlannerOutput };

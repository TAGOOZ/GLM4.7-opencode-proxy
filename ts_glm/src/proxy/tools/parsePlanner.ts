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

export { tryParseModelOutput, tryRepairPlannerOutput };


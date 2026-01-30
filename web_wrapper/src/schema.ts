import Ajv, { type JSONSchemaType } from "ajv";
import type { ModelOutput } from "./types.js";

const actionSchema: JSONSchemaType<ModelOutput["actions"][number]> = {
  type: "object",
  additionalProperties: false,
  required: ["tool", "args", "why", "expect", "safety"],
  properties: {
    tool: { type: "string" },
    args: { type: "object" },
    why: { type: "string" },
    expect: { type: "string" },
    safety: {
      type: "object",
      additionalProperties: false,
      required: ["risk", "notes"],
      properties: {
        risk: { type: "string", enum: ["low", "medium", "high"] },
        notes: { type: "string" }
      }
    }
  }
};

const schema: JSONSchemaType<ModelOutput> = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "actions"],
  properties: {
    plan: { type: "array", items: { type: "string" } },
    actions: { type: "array", items: actionSchema },
    final: { type: "string", nullable: true },
    thought: { type: "string", nullable: true }
  }
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validate = ajv.compile(schema);

export const validateModelOutput = (data: unknown): { ok: boolean; errors?: string[] } => {
  const ok = validate(data);
  if (!ok) {
    return { ok: false, errors: validate.errors?.map((e) => `${e.instancePath} ${e.message}`) };
  }
  const cast = data as ModelOutput;
  if (cast.actions.length > 0 && typeof cast.final === "string") {
    return { ok: false, errors: ["final is forbidden when actions are non-empty"] };
  }
  if (cast.actions.length === 0 && typeof cast.final !== "string") {
    return { ok: false, errors: ["final is required when actions are empty"] };
  }
  return { ok: true };
};

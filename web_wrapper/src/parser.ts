import { validateModelOutput } from "./schema.js";
import type { ModelOutput } from "./types.js";

const stripFences = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  return input;
};

const removeComments = (input: string): string => {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
};

const removeTrailingCommas = (input: string): string => {
  return input.replace(/,\s*([}\]])/g, "$1");
};

export const extractFirstJsonObject = (raw: string): { json?: string; error?: string } => {
  const cleaned = stripFences(raw);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return { json: cleaned.slice(start, i + 1) };
      }
    }
  }
  return { error: "no complete JSON object found" };
};

export const parseModelOutput = (raw: string, strict: boolean): { ok: boolean; data?: ModelOutput; error?: string } => {
  const extracted = extractFirstJsonObject(raw);
  if (!extracted.json) {
    return { ok: false, error: extracted.error || "missing JSON" };
  }

  if (strict) {
    const trimmed = raw.trim();
    const jsonTrimmed = extracted.json.trim();
    if (trimmed !== jsonTrimmed) {
      return { ok: false, error: "non-JSON content detected in strict mode" };
    }
  }

  const candidates = [extracted.json, removeTrailingCommas(removeComments(extracted.json))];

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate) as ModelOutput;
      const validation = validateModelOutput(data);
      if (!validation.ok) {
        return { ok: false, error: validation.errors?.join("; ") };
      }
      return { ok: true, data };
    } catch (err) {
      continue;
    }
  }

  return { ok: false, error: "invalid JSON" };
};

import { normalizeJsonCandidate, parseRawJson } from "../../tools/parseJson.js";

const truncateValue = (value: unknown, limit = 240): unknown => {
  if (typeof value !== "string") return value;
  if (value.length <= limit) return value;
  return value.slice(0, limit) + `...[truncated ${value.length - limit} chars]`;
};

const summarizeArgs = (args: Record<string, unknown>): string => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args || {})) out[k] = truncateValue(v);
  try {
    return JSON.stringify(out);
  } catch {
    return "[unserializable args]";
  }
};

const asPlainObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const parseToolCallArguments = (
  rawArgs: unknown,
): { ok: true; args: Record<string, unknown>; rewritten: boolean } | { ok: false } => {
  if (rawArgs == null) return { ok: true, args: {}, rewritten: false };
  if (typeof rawArgs === "object") {
    const obj = asPlainObject(rawArgs);
    if (obj) return { ok: true, args: obj, rewritten: false };
    return { ok: false };
  }
  if (typeof rawArgs !== "string") return { ok: false };

  try {
    const parsed = JSON.parse(rawArgs);
    const obj = asPlainObject(parsed);
    if (obj) return { ok: true, args: obj, rewritten: false };
  } catch {
    // continue
  }

  const normalized = normalizeJsonCandidate(rawArgs);
  if (normalized !== rawArgs) {
    try {
      const parsed = JSON.parse(normalized);
      const obj = asPlainObject(parsed);
      if (obj) return { ok: true, args: obj, rewritten: true };
    } catch {
      // continue
    }
  }

  const reparsed = parseRawJson(rawArgs);
  const reparsedObj = asPlainObject(reparsed);
  if (reparsedObj) {
    return { ok: true, args: reparsedObj, rewritten: true };
  }
  return { ok: false };
};

const rewriteToolCallArgs = (call: any, args: Record<string, unknown>) => {
  if (!call || typeof call !== "object") return;
  if (!call.function || typeof call.function !== "object") return;
  call.function.arguments = JSON.stringify(args);
};

export { parseToolCallArguments, rewriteToolCallArgs, summarizeArgs, truncateValue };

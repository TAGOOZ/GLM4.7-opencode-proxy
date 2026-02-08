import { asPlainObject, normalizeJsonCandidate, selectJsonEnvelope } from "../../tools/parseJson.js";

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

const normalizeToolName = (value: string) => value.toLowerCase().replace(/[_-]/g, "");

const decodeCommonEscapes = (value: string): string => {
  return value
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
};

const tryRecoverWriteArgs = (rawArgs: string): Record<string, unknown> | null => {
  const text = String(rawArgs || "").trim();
  if (!text.startsWith("{")) return null;
  const pathMatch = text.match(/"(filePath|file_path|path)"\s*:\s*"([^"]*)"/);
  const contentKey = /"content"\s*:\s*"/g;
  const contentMatch = contentKey.exec(text);
  if (!pathMatch || !contentMatch) return null;
  const valueStart = contentMatch.index + contentMatch[0].length;
  const objectEnd = text.lastIndexOf("}");
  if (objectEnd <= valueStart) return null;
  const valueEnd = text.lastIndexOf("\"", objectEnd - 1);
  if (valueEnd <= valueStart) return null;
  const pathKey = pathMatch[1];
  const pathValue = decodeCommonEscapes(pathMatch[2] || "");
  const contentValue = decodeCommonEscapes(text.slice(valueStart, valueEnd));
  if (!pathValue) return null;
  return {
    [pathKey]: pathValue,
    content: contentValue,
  };
};

const parseToolCallArguments = (
  rawArgs: unknown,
  toolName?: string,
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

  const envelope = selectJsonEnvelope(rawArgs);
  if (envelope && envelope.startsWith("{")) {
    try {
      const parsed = JSON.parse(envelope);
      const obj = asPlainObject(parsed);
      if (obj) return { ok: true, args: obj, rewritten: true };
    } catch {
      const repaired = normalizeJsonCandidate(envelope);
      if (repaired !== envelope) {
        try {
          const parsed = JSON.parse(repaired);
          const obj = asPlainObject(parsed);
          if (obj) return { ok: true, args: obj, rewritten: true };
        } catch {
          // continue
        }
      }
    }
  }
  if (typeof rawArgs === "string") {
    const normalized = normalizeToolName(String(toolName || ""));
    if (normalized === "write" || normalized === "writefile") {
      const recovered = tryRecoverWriteArgs(rawArgs);
      if (recovered) return { ok: true, args: recovered, rewritten: true };
    }
  }
  return { ok: false };
};

const rewriteToolCallArgs = (call: any, args: Record<string, unknown>) => {
  if (!call || typeof call !== "object") return;
  if (!call.function || typeof call.function !== "object") return;
  call.function.arguments = JSON.stringify(args);
};

export { parseToolCallArguments, rewriteToolCallArgs, summarizeArgs, truncateValue };

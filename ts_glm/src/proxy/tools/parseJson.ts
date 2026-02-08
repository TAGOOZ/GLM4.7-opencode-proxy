import { removeComments, removeTrailingCommas } from "web-wrapper-protocol";

const stripFences = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  return trimmed;
};

const hasWordChars = (text: string): boolean => /[A-Za-z0-9]/.test(text);
const EXAMPLE_CONTEXT_REGEX =
  /\b(example|schema|shape|template|sample|illustrative|for reference|do not execute|don't execute|not a call)\b/i;

const asPlainObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
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

const normalizeJsonCandidate = (text: string): string => {
  const newlineFixed = repairUnescapedNewlines(text);
  const argsFixed = repairArgumentsStrings(newlineFixed);
  const withoutComments = removeComments(argsFixed);
  const withoutTrailing = removeTrailingCommas(withoutComments);
  return withoutTrailing;
};

const selectJsonEnvelope = (
  raw: string,
  options?: { allowProse?: boolean },
): string | null => {
  const allowProse = Boolean(options?.allowProse);
  const cleaned = stripFences(String(raw || "")).trim();
  if (!cleaned) return null;

  const objectIdx = cleaned.indexOf("{");
  const arrayIdx = cleaned.indexOf("[");

  let start = -1;
  let openChar = "{";
  let closeChar = "}";

  if (arrayIdx !== -1 && (objectIdx === -1 || arrayIdx < objectIdx)) {
    start = arrayIdx;
    openChar = "[";
    closeChar = "]";
  } else if (objectIdx !== -1) {
    start = objectIdx;
  }

  if (start === -1) return null;

  const prefix = cleaned.slice(0, start).trim();
  if (!allowProse && hasWordChars(prefix)) return null;
  if (allowProse && EXAMPLE_CONTEXT_REGEX.test(prefix)) return null;

  const block = extractJsonBlock(cleaned.slice(start), openChar, closeChar);
  if (!block) return null;

  const suffix = cleaned.slice(start + block.length).trim();
  if (!allowProse && hasWordChars(suffix)) return null;
  if (allowProse && EXAMPLE_CONTEXT_REGEX.test(suffix)) return null;

  return block;
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

export {
  asPlainObject,
  extractJsonBlock,
  findStringEnd,
  normalizeJsonCandidate,
  parseRawJson,
  selectJsonEnvelope,
  stripFences,
};

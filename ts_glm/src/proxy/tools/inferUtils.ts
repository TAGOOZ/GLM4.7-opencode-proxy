import type { ToolInfo } from "./registry.js";

const looksLikePath = (value: string | null): boolean => {
  if (!value) return false;
  if (value.startsWith("~") || value.startsWith(".") || value.includes("/") || value.includes("\\")) return true;
  if (/\.[A-Za-z0-9]{1,10}$/.test(value)) return true;
  return false;
};

const extractQuotedText = (text: string): string | null => {
  const matches = [...text.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)];
  if (!matches.length) return null;
  const candidates = matches
    .map((match) => (match[1] || match[2] || match[3] || "").trim())
    .filter(Boolean);
  if (!candidates.length) return null;
  const nonPath = candidates.find((value) => !looksLikePath(value));
  return nonPath || candidates[0] || null;
};

const stripOuterQuotes = (value: string): string => {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("`") && value.endsWith("`"))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const extractKeyValueArgs = (raw: string): Record<string, string> | null => {
  const matches = [...raw.matchAll(/([A-Za-z0-9_]+)=("([^"]*)"|'([^']*)'|`([^`]*)`|([^\\s]+))/g)];
  if (!matches.length) return null;
  const args: Record<string, string> = {};
  for (const match of matches) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? match[5] ?? match[6] ?? "";
    args[key] = value;
  }
  return Object.keys(args).length ? args : null;
};

const extractDirPath = (text: string): string | null => {
  const matches = [...text.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)];
  if (matches.length) {
    let candidate = matches[matches.length - 1].slice(1).find(Boolean) as string | undefined;
    if (candidate) {
      candidate = candidate.replace(/[.,:;!?)]$/, "");
      if (candidate === "/" || candidate === "\\") {
        return null;
      }
      if (!/\.[A-Za-z0-9]{1,10}$/.test(candidate)) {
        return candidate;
      }
    }
  }
  const tokens = text.trim().split(/\s+/).map((t) => t.replace(/[.,:;!?)]$/, ""));
  const token = tokens.find((t) => {
    if (t === "/" || t === "\\") return false;
    const hasPathHint = t.includes("/") || t.includes("\\") || t.startsWith("~") || t.startsWith(".");
    return hasPathHint && !/\.[A-Za-z0-9]{1,10}$/.test(t);
  });
  return token || null;
};

const shellEscape = (value: string): string => {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

const pickArgKey = (toolInfo: ToolInfo | null, candidates: string[]): string => {
  const argKeys = toolInfo?.argKeys || [];
  for (const key of candidates) {
    if (argKeys.includes(key)) return key;
  }
  return candidates[0];
};

const extractFilePath = (text: string): string | null => {
  let normalized = text.trim();
  if (
    (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
    (normalized.startsWith("'") && normalized.endsWith("'")) ||
    (normalized.startsWith("`") && normalized.endsWith("`"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  const fileMatches = [...normalized.matchAll(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,10})/g)];
  if (fileMatches.length) {
    return fileMatches[fileMatches.length - 1][1];
  }
  const matches = [...normalized.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)];
  if (matches.length) {
    let candidate = matches[matches.length - 1].slice(1).find(Boolean) as string | undefined;
    if (candidate) {
      candidate = candidate.replace(/[.,:;!?)]$/, "");
      const lowered = candidate.toLowerCase();
      if (
        lowered.startsWith("read ") ||
        lowered.startsWith("open ") ||
        lowered.startsWith("show ") ||
        lowered.startsWith("cat ")
      ) {
        candidate = candidate.replace(/^(read|open|show|cat)\s+/i, "");
      }
      return candidate;
    }
  }
  const tokens = normalized.split(/\s+/).map((t) => t.replace(/[.,:;!?)]$/, ""));
  const token = tokens.find((t) => /\.[A-Za-z0-9]{1,10}$/.test(t));
  if (token) return token;
  const pathToken = tokens.find((t) => /[\\/]/.test(t) || t.startsWith("~") || t.startsWith("."));
  return pathToken || null;
};

export {
  extractDirPath,
  extractFilePath,
  extractKeyValueArgs,
  extractQuotedText,
  looksLikePath,
  pickArgKey,
  shellEscape,
  stripOuterQuotes,
};

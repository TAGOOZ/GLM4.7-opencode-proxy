import type { FastifyReply } from "fastify";
import { extractFirstJsonObject, repairPlannerJson } from "web-wrapper-protocol";
import { PROXY_DEBUG, PROXY_INCLUDE_USAGE } from "../constants.js";
import { estimateTokens, type ContextStats } from "../context.js";
import { tryParseModelOutput, tryRepairPlannerOutput } from "../tools/parse.js";
import { findTool, type ToolInfo } from "../tools/registry.js";

const normalizeDeltaContent = (content: string): string => {
  return content.trim();
};

const sortJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const out: Record<string, unknown> = {};
  for (const [key, nested] of entries) out[key] = sortJsonValue(nested);
  return out;
};

const stableStringify = (value: unknown): string => {
  try {
    return JSON.stringify(sortJsonValue(value));
  } catch {
    return "";
  }
};

export const parseToolCallArgs = (call: any): Record<string, unknown> | null => {
  const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
  if (rawArgs && typeof rawArgs === "object") {
    return rawArgs as Record<string, unknown>;
  }
  if (typeof rawArgs !== "string") return {};
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return {};
  } catch {
    return null;
  }
};

const getFirstStringArg = (args: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return null;
};

export const isNoOpEditArgs = (toolName: string, args: Record<string, unknown>): boolean => {
  if (!EDIT_TOOL_NAMES.has(normalizeToolName(toolName))) return false;
  const oldString = getFirstStringArg(args, ["oldString", "old_string", "oldText", "old_text"]);
  const newString = getFirstStringArg(args, ["newString", "new_string", "newText", "new_text"]);
  return oldString !== null && newString !== null && oldString === newString;
};

export const buildToolCallSignature = (call: any): string | null => {
  const toolName = normalizeToolName(call?.function?.name || call?.name || "");
  if (!toolName) return null;
  const args = parseToolCallArgs(call);
  if (args === null) return null;
  const payload = stableStringify(args);
  if (!payload) return null;
  return `${toolName}|${payload}`;
};

const messageDeltaKey = (msg: any) => {
  const role = msg?.role;
  const toolCalls = Array.isArray(msg?.tool_calls)
    ? msg.tool_calls.map((call: any) => ({
        type: call?.type,
        function: call?.function
          ? {
              name: call.function.name,
              arguments: call.function.arguments,
            }
          : undefined,
      }))
    : undefined;
  const toolCallId = role === "tool" ? msg?.tool_call_id : undefined;
  const rawContent = extractContentText(msg?.content);
  const content = rawContent ? normalizeDeltaContent(rawContent) : rawContent;
  return JSON.stringify({
    role,
    tool_call_id: toolCallId,
    tool_calls: toolCalls,
    content,
  });
};

export const EDIT_TOOL_NAMES = new Set(["edit", "editfile", "applypatch", "patch"]);

export const extractContentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part === "object") {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
};

export const buildUsage = (promptTokens: number, completionText: string) => {
  if (!PROXY_INCLUDE_USAGE) return undefined;
  const completionTokens = estimateTokens(completionText);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
};

export const buildToolUsage = (promptTokens: number, toolCalls: any[]) => {
  if (!PROXY_INCLUDE_USAGE) return undefined;
  const completionTokens = estimateTokens(JSON.stringify(toolCalls));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
};

export const buildStreamHeaders = (stats?: ContextStats): Record<string, string> => {
  if (!PROXY_INCLUDE_USAGE || !stats) return {};
  return {
    "x-context-used": String(stats.usedTokens),
    "x-context-remaining": String(stats.remainingTokens),
    "x-context-budget": String(stats.budgetTokens),
  };
};

export const applyResponseHeaders = (reply: FastifyReply, stats?: ContextStats) => {
  if (!PROXY_INCLUDE_USAGE || !stats) return;
  reply.header("x-context-used", String(stats.usedTokens));
  reply.header("x-context-remaining", String(stats.remainingTokens));
  reply.header("x-context-budget", String(stats.budgetTokens));
};

export const buildSignature = (tools: any[], systemText: string) => {
  return JSON.stringify({
    tools,
    system: systemText,
  });
};

export const normalizeToolName = (value: unknown) =>
  String(value || "").toLowerCase().replace(/[_-]/g, "");

export const computeDeltaMessages = (current: any[], lastMessages: any[]) => {
  const currentKeys = current.map(messageDeltaKey);
  const lastKeys = lastMessages.map(messageDeltaKey);
  let idx = 0;
  while (idx < currentKeys.length && idx < lastKeys.length && currentKeys[idx] === lastKeys[idx]) {
    idx += 1;
  }
  const mismatch = idx < lastKeys.length && idx < currentKeys.length;
  const truncated = currentKeys.length < lastKeys.length;
  if (mismatch || truncated) {
    if (PROXY_DEBUG) {
      console.log(
        "proxy_debug delta_mismatch:",
        JSON.stringify({
          index: idx,
          last: lastKeys[idx]?.slice(0, 200),
          current: currentKeys[idx]?.slice(0, 200),
          lastLen: lastKeys.length,
          currentLen: currentKeys.length,
          truncated,
        }),
      );
    }
    return { delta: current, reseed: true, reset: true };
  }
  return { delta: current.slice(idx), reseed: idx === 0, reset: false };
};

export const extractPlannerFinal = (text: string): string | null => {
  if (!text || !text.trim()) return null;
  const parsed = tryParseModelOutput(text, true);
  if (parsed.ok && parsed.data && parsed.data.actions.length === 0) {
    return parsed.data.final || "";
  }
  const repaired = tryRepairPlannerOutput(text);
  if (repaired && repaired.actions.length === 0) {
    return repaired.final || "";
  }
  return null;
};

export const isAffirmativeConfirmation = (value: string): boolean => {
  const text = (value || "").trim().toLowerCase();
  if (!text) return false;
  const isAffirmativeChoice = (choice: string): boolean => {
    const normalized = choice.trim().toLowerCase();
    if (!normalized) return false;
    if (
      [
        "y",
        "yes",
        "true",
        "ok",
        "okay",
        "proceed",
        "proceed (recommended)",
        "continue",
        "confirm",
        "approved",
        "allow",
        "1",
      ].includes(normalized)
    ) {
      return true;
    }
    if (/^(yes|ok|okay|proceed|continue|confirm|approved|allow)\b/.test(normalized)) {
      return true;
    }
    return false;
  };
  if (isAffirmativeChoice(text)) {
    return true;
  }
  const answeredMatch = text.match(/=\s*"([^"]+)"/);
  if (answeredMatch && isAffirmativeChoice(answeredMatch[1] || "")) {
    return true;
  }
  if (/user has answered your questions:/i.test(text) && /proceed\s*\(recommended\)/i.test(text)) {
    return true;
  }
  // Some UIs may return JSON.
  try {
    const parsed = JSON.parse(text);
    if (parsed === true) return true;
    if (parsed && typeof parsed === "object") {
      const ok = (parsed as any).ok ?? (parsed as any).confirmed ?? (parsed as any).confirm;
      if (ok === true) return true;
      const answer =
        (parsed as any).answer ??
        (parsed as any).selected ??
        (parsed as any).selection ??
        (parsed as any).value;
      if (typeof answer === "string" && isAffirmativeChoice(answer)) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
};

export const detectUnknownToolFromUserJson = (
  userText: string,
  registry: Map<string, ToolInfo>,
): string | null => {
  if (!userText || userText.indexOf("{") === -1) return null;
  const extracted = extractFirstJsonObject(userText);
  if (!extracted.json) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(repairPlannerJson(extracted.json));
  } catch {
    return null;
  }
  const rawActions = Array.isArray(parsed?.actions)
    ? parsed.actions
    : parsed?.actions
      ? [parsed.actions]
      : [];
  for (const action of rawActions) {
    const name = typeof action?.tool === "string" ? action.tool : "";
    if (!name) continue;
    if (!findTool(registry, name)) return name;
  }
  return null;
};

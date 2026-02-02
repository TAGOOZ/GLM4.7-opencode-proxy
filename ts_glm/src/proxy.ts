#!/usr/bin/env node
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { GLMClient } from "./glmClient.js";
import { loadToken } from "./config.js";
import crypto from "crypto";
import {
  SYSTEM_PROMPT,
  extractFirstJsonObject,
  parseModelOutput,
  validateModelOutput,
  type ModelOutput,
} from "web-wrapper-protocol";

const app = Fastify();
app.register(cors, { origin: true });

const token = loadToken();
if (!token) {
  console.error("Missing GLM token. Set GLM_TOKEN or run 'glm config --token'.");
  process.exit(1);
}

const client = new GLMClient(token);
let proxyChatId: string | null = null;

const ensureChat = async (): Promise<string> => {
  if (process.env.PROXY_NEW_CHAT_PER_REQUEST === "1" || !proxyChatId) {
    const chat = await client.createChat("OpenCode Proxy", "glm-4.7");
    proxyChatId = chat.id;
  }
  return proxyChatId;
};

const buildToolPrompt = (tools: any[]): string => {
  const lines = [SYSTEM_PROMPT, "", "Allowed tools:"];
  for (const tool of tools) {
    const fn = tool.function || {};
    const name = fn.name || tool.name || "tool";
    lines.push(`- ${name}: ${fn.description || ""}`.trim());
    if (fn.parameters) {
      lines.push(`  parameters: ${JSON.stringify(fn.parameters)}`);
    }
  }
  lines.push("");
  lines.push("Examples (format only):");
  lines.push(
    JSON.stringify({
      plan: ["inspect file"],
      actions: [
        {
          tool: "TOOL_NAME",
          args: { path: "README.md" },
          why: "need the file contents",
          expect: "file text",
          safety: { risk: "low", notes: "" },
        },
      ],
    })
  );
  lines.push(
    JSON.stringify({
      plan: ["answer directly"],
      actions: [],
      final: "Concise response to the user.",
    })
  );
  return lines.join("\n");
};

const normalizeToolName = (name: string) => name.toLowerCase().replace(/[_-]/g, "");

const isNameMatch = (target: string, candidate: string) => {
  if (candidate === target) return true;
  if (candidate.startsWith(target)) return true;
  if (candidate === `${target}file`) return true;
  if (candidate === `${target}dir`) return true;
  return false;
};

const extractContentText = (content: unknown): string => {
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

const removeComments = (input: string): string => {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
};

const removeTrailingCommas = (input: string): string => {
  return input.replace(/,\s*([}\]])/g, "$1");
};

const repairPlannerJson = (input: string): string => {
  let repaired = removeTrailingCommas(removeComments(input));
  const planMatch = repaired.match(/"plan"\s*:\s*([\s\S]*?)(?=,\s*"actions"\s*:)/);
  if (planMatch && !planMatch[1].trim().startsWith("[")) {
    const body = planMatch[1].trim().replace(/,\s*$/, "");
    repaired = repaired.replace(planMatch[0], `"plan": [${body}]`);
  }
  const actionsMatch = repaired.match(/"actions"\s*:\s*([\s\S]*?)(?=,\s*"(final|thought)"\s*:|}$)/);
  if (actionsMatch && !actionsMatch[1].trim().startsWith("[")) {
    const body = actionsMatch[1].trim().replace(/,\s*$/, "");
    repaired = repaired.replace(actionsMatch[0], `"actions": [${body}]`);
  }
  return repaired;
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

type ToolLike = {
  name?: string;
  parameters?: { properties?: Record<string, unknown> };
  function?: {
    name?: string;
    parameters?: { properties?: Record<string, unknown> };
    tool?: {
      name?: string;
      parameters?: { properties?: Record<string, unknown> };
    };
  };
};

type ToolInfo = {
  tool: ToolLike;
  argKeys: string[];
};

const ARG_SYNONYMS: Record<string, string> = {
  filepath: "path",
  file_path: "path",
  filename: "path",
  file: "path",
  cmd: "command",
};

const TOOL_NAME_ALIASES: Record<string, string[]> = {
  read: ["read_file", "readfile", "open_file"],
  write: ["write_file", "writefile", "save_file", "create_file"],
  list: ["list_dir", "listdir"],
  run: ["run_shell", "shell", "bash"],
};

const collectToolNames = (tool: ToolLike): string[] => {
  const names: string[] = [];
  const fn = tool.function || {};
  if (fn.name) names.push(fn.name);
  if (fn.tool?.name) names.push(fn.tool.name);
  if (tool.name) names.push(tool.name);
  return names;
};

const collectArgKeys = (tool: ToolLike): string[] => {
  const props =
    tool?.function?.parameters?.properties ||
    tool?.parameters?.properties ||
    tool?.function?.tool?.parameters?.properties ||
    {};
  return Object.keys(props);
};

const buildToolRegistry = (tools: ToolLike[]): Map<string, ToolInfo> => {
  const registry = new Map<string, ToolInfo>();
  for (const tool of tools) {
    const argKeys = collectArgKeys(tool);
    const info: ToolInfo = { tool, argKeys };
    for (const name of collectToolNames(tool)) {
      const normalized = normalizeToolName(name);
      if (registry.has(normalized)) {
        if (process.env.PROXY_DEBUG) {
          console.warn(`proxy_debug tool_name_collision: ${normalized}`);
        }
        continue;
      }
      registry.set(normalized, info);
    }
  }
  for (const [canonical, aliases] of Object.entries(TOOL_NAME_ALIASES)) {
    const allNames = [canonical, ...aliases];
    let info: ToolInfo | undefined;
    for (const name of allNames) {
      const match = registry.get(normalizeToolName(name));
      if (match) {
        info = match;
        break;
      }
    }
    if (!info) continue;
    // Alias expansion intentionally maps the same tool under multiple normalized names.
    for (const name of allNames) {
      const normalized = normalizeToolName(name);
      if (!registry.has(normalized)) {
        registry.set(normalized, info);
      }
    }
  }
  return registry;
};

const findTool = (registry: Map<string, ToolInfo>, name: string): ToolInfo | null => {
  const target = normalizeToolName(name);
  const direct = registry.get(target);
  if (direct) return direct;
  // Fallback: scan normalized keys for prefix matches. Tool lists are typically small.
  for (const [candidate, info] of registry.entries()) {
    if (isNameMatch(target, candidate)) return info;
  }
  return null;
};

const normalizeArgsForTool = (toolInfo: ToolInfo | null, args: Record<string, unknown>): Record<string, unknown> => {
  const allowed = toolInfo?.argKeys || [];
  if (!allowed.length) return args;
  const allowedNorm = new Map<string, string>();
  for (const key of allowed) {
    allowedNorm.set(normalizeToolName(key), key);
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const keyNorm = normalizeToolName(key);
    const direct = allowedNorm.get(keyNorm);
    if (direct) {
      normalized[direct] = value;
      continue;
    }
    if (keyNorm === "path" && allowedNorm.has("filepath")) {
      normalized[allowedNorm.get("filepath") as string] = value;
      continue;
    }
    const synonym = ARG_SYNONYMS[keyNorm];
    if (synonym) {
      const synKey = allowedNorm.get(normalizeToolName(synonym));
      if (synKey) {
        normalized[synKey] = value;
        continue;
      }
    }
    normalized[key] = value;
  }
  const descKey = allowedNorm.get("description");
  if (descKey && normalized[descKey] == null) {
    const command = normalized.command ?? normalized.cmd;
    const detail =
      typeof command === "string" && command.trim()
        ? `run shell command: ${command.trim()}`
        : "run shell command";
    normalized[descKey] = detail;
  }
  return normalized;
};

const stripFences = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  return trimmed;
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
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
};

const parseRawJson = (raw: string): any | null => {
  const cleaned = stripFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    // try arrays first (tool_calls often output as arrays)
    const arrayBlock = extractJsonBlock(cleaned, "[", "]");
    if (arrayBlock) {
      try {
        return JSON.parse(arrayBlock);
      } catch {
        // ignore
      }
    }
    const objectBlock = extractJsonBlock(cleaned, "{", "}");
    if (objectBlock) {
      try {
        return JSON.parse(objectBlock);
      } catch {
        // ignore
      }
    }
  }
  return null;
};

const parseRawToolCalls = (raw: string, registry: Map<string, ToolInfo>) => {
  const data = parseRawJson(raw);
  if (!data) return null;
  let calls: any[] = [];
  if (Array.isArray(data)) {
    calls = data;
  } else if (Array.isArray(data.tool_calls)) {
    calls = data.tool_calls;
  } else if (data.tool && data.arguments !== undefined) {
    calls = [{ tool: data.tool, arguments: data.arguments }];
  } else if (data.function || data.name) {
    calls = [data];
  } else {
    return null;
  }

  const toolCalls = [];
  for (const call of calls) {
    const func = call.function || call;
    const rawName = func?.name || call.name || call.tool;
    if (!rawName) continue;
    const toolInfo = findTool(registry, rawName);
    if (!toolInfo) continue;
    let args = func?.arguments ?? call.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (!args || typeof args !== "object") {
      args = {};
    }
    args = normalizeArgsForTool(toolInfo, args as Record<string, unknown>);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || rawName;
    toolCalls.push({
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: toolCalls.length,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(args),
      },
    });
  }
  return toolCalls.length ? toolCalls : null;
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

const extractCommand = (text: string): string | null => {
  const fence = text.match(/```(?:bash|sh)?\n([\s\S]+?)```/i);
  if (fence && fence[1]) {
    return fence[1].trim();
  }
  const inline = text.match(/`([^`]+)`/);
  if (inline && inline[1]) {
    return inline[1].trim();
  }
  const runMatch = text.match(/(?:^|\n)\s*\b(?:run|execute)\s*[:\-]?\s*(.+)$/im);
  if (runMatch && runMatch[1]) {
    return runMatch[1].trim();
  }
  return null;
};

const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bmkfs\b/i,
  /\bdd\b/i,
  /\bcurl\b.*\|\s*sh/i,
  /\bwget\b.*\|\s*sh/i,
  /:\(\)\s*\{:\|:&\};:/,
];

const isDangerousCommand = (command: string): boolean => {
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
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

const extractPatchBlock = (text: string): string | null => {
  const fenced = text.match(/```(?:diff|patch)?\n([\s\S]+?)```/i);
  if (fenced && fenced[1]) {
    const block = fenced[1].trim();
    if (/^\s*(\*\*\* Begin Patch|diff --git)/m.test(block)) {
      return block;
    }
  }
  const begin = text.indexOf("*** Begin Patch");
  const end = text.indexOf("*** End Patch");
  if (begin !== -1 && end !== -1 && end > begin) {
    return text.slice(begin, end + "*** End Patch".length).trim();
  }
  return null;
};

const parsePatchForEdit = (patch: string): { filePath: string; oldString: string; newString: string } | null => {
  const fileMatch =
    patch.match(/^\*\*\*\s+Update File:\s*(.+)$/m) ||
    patch.match(/^\+\+\+\s+b\/(.+)$/m) ||
    patch.match(/^diff --git a\/.+ b\/(.+)$/m);
  if (!fileMatch) return null;
  const filePath = fileMatch[1]?.trim();
  if (!filePath) return null;
  const lines = patch.split(/\r?\n/);
  let inHunk = false;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("*** End Patch")) break;
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      continue;
    }
  }
  if (!oldLines.length || !newLines.length) return null;
  return { filePath, oldString: oldLines.join("\n"), newString: newLines.join("\n") };
};

const extractDirPath = (text: string): string | null => {
  const matches = [...text.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)];
  if (matches.length) {
    let candidate = matches[matches.length - 1].slice(1).find(Boolean) as string | undefined;
    if (candidate) {
      candidate = candidate.replace(/[.,:;!?)]$/, "");
      if (!/\.[A-Za-z0-9]{1,10}$/.test(candidate)) {
        return candidate;
      }
    }
  }
  const tokens = text.trim().split(/\s+/).map((t) => t.replace(/[.,:;!?)]$/, ""));
  const token = tokens.find((t) => (t.includes("/") || t.includes("\\") || t.startsWith("~") || t.startsWith(".")) && !/\.[A-Za-z0-9]{1,10}$/.test(t));
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
  const fileMatches = [...normalized.matchAll(/([A-Za-z0-9_./-]+\\.[A-Za-z0-9]{1,10})/g)];
  if (fileMatches.length) {
    return fileMatches[fileMatches.length - 1][1];
  }
  const matches = [...normalized.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)];
  if (matches.length) {
    let candidate = matches[matches.length - 1].slice(1).find(Boolean) as string | undefined;
    if (candidate) {
      candidate = candidate.replace(/[.,:;!?)]$/, "");
      const lowered = candidate.toLowerCase();
      if (lowered.startsWith("read ") || lowered.startsWith("open ") || lowered.startsWith("show ") || lowered.startsWith("cat ")) {
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

const looksLikePath = (value: string | null): boolean => {
  if (!value) return false;
  if (value.startsWith("~") || value.startsWith(".") || value.includes("/") || value.includes("\\")) return true;
  if (/\.[A-Za-z0-9]{1,10}$/.test(value)) return true;
  return false;
};

const inferReadToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const lowered = userText.toLowerCase();
  const readIntent = ["read", "open", "show", "cat", "contents", "what is in", "what's in", "display"];
  const path = extractFilePath(userText);
  const hasSearchIntent = /\b(search|find)\b/.test(lowered);
  const hasReadIntent = readIntent.some((k) => lowered.includes(k)) || hasSearchIntent;
  const hasRunTool = Boolean(findTool(registry, "run") || findTool(registry, "run_shell"));
  if (!hasReadIntent) return null;
  if (hasSearchIntent && hasRunTool) return null;
  if (/\b(directory|folder|dir)\b/.test(lowered) && path && !/\.[A-Za-z0-9]{1,10}$/.test(path)) {
    return null;
  }
  const toolInfo = findTool(registry, "read");
  if (!toolInfo) return null;
  if (!path) return null;
  const key = pickArgKey(toolInfo, ["filePath", "path"]);
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "read";
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify({ [key]: path }) },
    },
  ];
};

const inferWriteToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const toolInfo = findTool(registry, "write");
  if (!toolInfo) return null;
  const patterns = [
    /create (?:a )?file\s+([\w./-]+)\s+with content\s+([\s\S]+)/i,
    /create (?:a )?file\s+([\w./-]+)\s+with\s+([\s\S]+)/i,
    /write\s+([\s\S]+?)\s+to\s+([\w./-]+)/i,
    /save\s+([\w./-]+)\s+content\s+([\s\S]+)/i,
  ];
  for (const pattern of patterns) {
    const match = userText.match(pattern);
    if (!match) continue;
    let filePath = match[1];
    let content = match[2];
    if (pattern === patterns[2]) {
      filePath = match[2];
      content = match[1];
    }
    filePath = filePath.replace(/^[\"'`]/, "").replace(/[\"'`].*$/, "");
    content = content.replace(/^[\"'`]/, "").replace(/[\"'`]$/, "");
    if (!filePath || !content) continue;
    const pathKey = pickArgKey(toolInfo, ["filePath", "path"]);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "write";
    return [
      {
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        index: 0,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify({ [pathKey]: filePath, content }) },
      },
    ];
  }
  // Fallback: "create file X" without content -> use placeholder
  const simple = userText.match(/create (?:a )?file\s+([\w./-]+)/i);
  if (simple && simple[1]) {
    const filePath = simple[1];
    const pathKey = pickArgKey(toolInfo, ["filePath", "path"]);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "write";
    return [
      {
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        index: 0,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify({ [pathKey]: filePath, content: "" }) },
      },
    ];
  }
  return null;
};

const inferApplyPatchToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const patch = extractPatchBlock(userText);
  if (!patch) return null;
  const toolInfo = findTool(registry, "apply_patch");
  if (!toolInfo) return null;
  const key = pickArgKey(toolInfo, ["patch", "input", "diff", "changes"]);
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "apply_patch";
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify({ [key]: patch }) },
    },
  ];
};

const inferEditToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const patch = extractPatchBlock(userText);
  if (!patch) return null;
  const toolInfo = findTool(registry, "edit") || findTool(registry, "edit_file");
  if (!toolInfo) return null;
  const parsed = parsePatchForEdit(patch);
  if (!parsed) return null;
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "edit";
  const args = {
    filePath: parsed.filePath,
    oldString: parsed.oldString,
    newString: parsed.newString,
  };
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify(normalizeArgsForTool(toolInfo, args)) },
    },
  ];
};

const inferGrepCommand = (userText: string): string | null => {
  const lowered = userText.toLowerCase();
  if (!/\b(rg|ripgrep|grep)\b/.test(lowered)) return null;
  const pattern = extractQuotedText(userText);
  if (!pattern) return null;
  const target = extractFilePath(userText);
  const path = target && looksLikePath(target) ? target : ".";
  const safePattern = shellEscape(pattern);
  const safePath = shellEscape(path);
  return /\bgrep\b/.test(lowered)
    ? `grep -R ${safePattern} ${safePath}`
    : `rg -n ${safePattern} ${safePath}`;
};

const inferSearchCommand = (userText: string): string | null => {
  const match = userText.match(/\b(?:search for|find)\s+(.+?)\s+in\s+(.+)/i);
  if (!match) return null;
  const pattern = stripOuterQuotes(match[1].trim());
  if (!pattern) return null;
  const target = stripOuterQuotes(match[2].trim()).replace(/[.,:;!?)]$/, "") || ".";
  const safePattern = shellEscape(pattern);
  const safePath = shellEscape(target);
  return `rg -n ${safePattern} ${safePath}`;
};

const inferDeleteCommand = (userText: string): string | null => {
  const lowered = userText.toLowerCase();
  if (!/\b(delete|remove)\b/.test(lowered)) return null;
  const target = extractFilePath(userText);
  if (!target || !looksLikePath(target)) return null;
  const isDir = /\b(directory|folder)\b/.test(lowered);
  const safeTarget = shellEscape(target);
  return isDir ? `rm -rf ${safeTarget}` : `rm -f ${safeTarget}`;
};

const inferMkdirCommand = (userText: string): string | null => {
  const mkdirMatch = userText.match(
    /(?:create|make)\s+(?:a\s+)?(?:directory|folder)\s+(?:\"([^\"]+)\"|'([^']+)'|`([^`]+)`|([^\s]+))/i
  );
  if (!mkdirMatch) return null;
  const raw = (mkdirMatch[1] || mkdirMatch[2] || mkdirMatch[3] || mkdirMatch[4] || "").trim();
  if (!raw) return null;
  const dirName = stripOuterQuotes(raw).replace(/[.,:;!?)]$/, "");
  return `mkdir -p ${shellEscape(dirName)}`;
};

const inferMoveCommand = (userText: string): string | null => {
  const mvMatch = userText.match(
    /(?:rename|move)\s+((?:\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s]+))\s+(?:to|as)\s+((?:\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s]+))/i
  );
  if (!mvMatch || !mvMatch[1] || !mvMatch[2]) return null;
  const src = stripOuterQuotes(mvMatch[1]).replace(/[.,:;!?)]$/, "");
  const dst = stripOuterQuotes(mvMatch[2]).replace(/[.,:;!?)]$/, "");
  return `mv ${shellEscape(src)} ${shellEscape(dst)}`;
};

const inferRunToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const toolInfo = findTool(registry, "run") || findTool(registry, "run_shell");
  if (!toolInfo) return null;
  const command = extractCommand(userText);
  let inferred: string | null = null;
  if (command) {
    const loweredCmd = command.toLowerCase().trim();
    if (!/^(rg|ripgrep|grep|rm|mkdir|mv)\b/.test(loweredCmd)) {
      if (!isDangerousCommand(command)) {
        inferred = command;
      } else if (process.env.PROXY_DEBUG) {
        console.warn("proxy_debug blocked_dangerous_command");
      }
    }
  }
  if (!inferred) {
    inferred =
      inferSearchCommand(userText) ||
      inferGrepCommand(userText) ||
      inferDeleteCommand(userText) ||
      inferMkdirCommand(userText) ||
      inferMoveCommand(userText);
  }
  if (!inferred) return null;
  const key = pickArgKey(toolInfo, ["command", "cmd"]);
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "run_shell";
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify({ [key]: inferred }) },
    },
  ];
};

const inferListToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const lowered = userText.toLowerCase();
  const listIntent = ["list files", "list folders", "list directory", "show files", "inspect files"];
  const dirIntent = [
    "directory contents",
    "folder contents",
    "contents of",
    "what is in",
    "what's in",
    "read directory",
    "read dir",
    "show directory",
    "show folder",
  ];
  const hasLsToken = /\bls\b/.test(lowered);
  if (!hasLsToken && !listIntent.some((k) => lowered.includes(k)) && !dirIntent.some((k) => lowered.includes(k))) {
    return null;
  }
  const toolInfo = findTool(registry, "glob") || findTool(registry, "list");
  if (!toolInfo) return null;
  const key = pickArgKey(toolInfo, ["pattern", "path"]);
  const dirPath = extractDirPath(userText) || ".";
  const pattern =
    dirPath === "." || dirPath === "./"
      ? "**/*"
      : `${dirPath.replace(/\/$/, "")}/**/*`;
  const args = key === "pattern" ? { [key]: pattern } : { [key]: dirPath };
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolInfo.tool.function?.name || toolInfo.tool.name || "glob", arguments: JSON.stringify(args) },
    },
  ];
};

const convertMessages = (messages: any[], tools: any[]): { role: string; content: string }[] => {
  const out: { role: string; content: string }[] = [];
  if (tools.length) {
    out.push({ role: "system", content: buildToolPrompt(tools) });
  }
  for (const msg of messages) {
    if (msg.role === "tool") {
      const rawContent = msg.content ?? "";
      const content =
        typeof rawContent === "object" ? JSON.stringify(rawContent) : String(rawContent || "");
      out.push({ role: "user", content: `Tool result (${msg.name || "tool"}):\n${content}` });
      continue;
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      out.push({ role: "assistant", content: JSON.stringify(msg.tool_calls) });
      continue;
    }
    out.push({ role: msg.role, content: extractContentText(msg.content) || "" });
  }
  return out;
};

const collectGlmResponse = async (
  chatId: string,
  glmMessages: { role: string; content: string }[],
) => {
  let content = "";
  let parentId: string | null = null;
  try {
    parentId = await client.getCurrentMessageId(chatId);
  } catch {
    parentId = null;
  }
  for await (const chunk of client.sendMessage({
    chatId,
    messages: glmMessages,
    includeHistory: false,
    enableThinking: false,
    parentMessageId: parentId,
  })) {
    if (chunk.type === "content") {
      content += chunk.data;
    }
  }
  return content.trim();
};

const openaiToolResponse = (toolCalls: any[], model: string) => ({
  id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: null, tool_calls: toolCalls },
      finish_reason: "tool_calls",
    },
  ],
});

const openaiContentResponse = (content: string, model: string) => ({
  id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
});

const streamContent = (content: string, model: string) => {
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  return [
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
};

const streamToolCalls = (toolCalls: any[], model: string) => {
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  return [
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: "tool_calls" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
};

const sendToolCalls = (reply: FastifyReply, toolCalls: any[], model: string, stream: boolean) => {
  if (stream) {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.raw.write(streamToolCalls(toolCalls, model));
    return reply.raw.end();
  }
  return reply.send(openaiToolResponse(toolCalls, model));
};

app.get("/", async () => ({ status: "ok", message: "GLM proxy is running" }));

app.get("/v1/models", async () => ({
  object: "list",
  data: [
    {
      id: "glm-4.7",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "z.ai",
    },
  ],
}));

app.get("/models", async () => ({
  object: "list",
  data: [
    {
      id: "glm-4.7",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "z.ai",
    },
  ],
}));

const handleChatCompletion = async (request: FastifyRequest, reply: FastifyReply) => {
  const body = request.body as any;
  const model = body.model || "glm-4.7";
  const messages = body.messages || [];
  const tools = body.tools || [];
  const stream = Boolean(body.stream);
  const toolChoice = body.tool_choice;

  if (toolChoice === "none") {
    tools.length = 0;
  }

  const chatId = await ensureChat();

  const lastUserContent = messages.slice().reverse().find((m: any) => m.role === "user")?.content;
  const lastUser = extractContentText(lastUserContent) || "";
  const last = messages[messages.length - 1];
  const hasToolResult = Boolean(last && (last.role === "tool" || last.tool_call_id));
  const toolResultCount = messages.filter((m: any) => m.role === "tool" || m.tool_call_id).length;
  const maxToolLoops = Number(process.env.PROXY_TOOL_LOOP_LIMIT || "3");
  const toolRegistry = buildToolRegistry(tools);
  const loweredUser = lastUser.toLowerCase();
  const hasEmbeddedRead = /Called the Read tool with the following input/i.test(lastUser);
  const fileMention =
    /@[^\\s]+/.test(lastUser) || /[A-Za-z0-9_./-]+\\.[A-Za-z0-9]{1,10}/.test(lastUser);
  const repoStructureIntent =
    /(repo|repository|project|folder|directory).*(structure|tree|files|folders|contents|layout)/.test(loweredUser) ||
    /check (the )?(repo|repository|project)/.test(loweredUser);
  const actionableKeywords = [
    "create",
    "write",
    "edit",
    "modify",
    "delete",
    "remove",
    "save",
    "rename",
    "move",
    "run",
    "execute",
    "install",
    "search",
    "find",
    "list",
    "open",
    "read",
    "inspect",
    "show",
    "contents",
    "grep",
    "rg",
    "ripgrep",
    "ls",
    "tree",
    "mkdir",
    "touch",
    "cp",
    "mv",
  ];
  const readLikeWithFile = /(summarize|summary|explain|describe|review|what does|what is in)/.test(loweredUser);
  let actionable =
    actionableKeywords.some((k) => loweredUser.includes(k)) ||
    repoStructureIntent ||
    (fileMention && readLikeWithFile);
  if (hasEmbeddedRead) {
    actionable = false;
  }
  if (process.env.PROXY_DEBUG) {
    const roles = messages.map((m: any) => m.role).join(",");
    const sys = messages.find((m: any) => m.role === "system")?.content || "";
    console.log("proxy_debug stream:", stream, "tool_choice:", toolChoice);
    console.log("proxy_debug roles:", roles);
    if (sys) {
      console.log("proxy_debug system:", sys.slice(0, 200));
    }
    if (hasToolResult) {
      const toolMsg = messages.slice().reverse().find((m: any) => m.role === "tool");
      const toolPreview = toolMsg?.content
        ? toolMsg.content.slice(0, 200)
        : "";
      console.log("proxy_debug tool_result_preview:", toolPreview);
    }
  }
  const toolChoiceRequired =
    toolChoice === "required" ||
    (toolChoice && typeof toolChoice === "object" && toolChoice.type === "function");

  const allowHeuristicTools = !hasEmbeddedRead;
  const inferredToolCall =
    allowHeuristicTools && !hasToolResult && tools.length > 0
      ? inferApplyPatchToolCall(toolRegistry, lastUser) ||
        inferEditToolCall(toolRegistry, lastUser) ||
        inferReadToolCall(toolRegistry, lastUser) ||
        inferWriteToolCall(toolRegistry, lastUser) ||
        inferRunToolCall(toolRegistry, lastUser) ||
        inferListToolCall(toolRegistry, lastUser)
      : null;

  const shouldAttemptTools =
    tools.length > 0 && (toolChoiceRequired || Boolean(inferredToolCall) || hasToolResult || actionable);
  let glmMessages = convertMessages(messages, shouldAttemptTools ? tools : []);
  if (hasToolResult && shouldAttemptTools) {
    glmMessages = [
      {
        role: "system",
        content:
          "Use the tool results to answer the user. If no further tools are needed, return a final response.",
      },
      ...glmMessages,
    ];
  }

  if (shouldAttemptTools) {
    const earlyFallback = inferredToolCall;
    if (process.env.PROXY_DEBUG) {
      console.log("proxy_debug tools:", tools.map((t: any) => t.function?.name || t.name || "tool"));
      console.log("proxy_debug lastUser:", lastUser);
      console.log("proxy_debug earlyFallback:", Boolean(earlyFallback));
    }
    if (earlyFallback) {
      return sendToolCalls(reply, earlyFallback, model, stream);
    }

    let responseText = await collectGlmResponse(chatId, glmMessages);
    const initialResponseText = responseText;
    if (process.env.PROXY_DEBUG) {
      const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
      console.log("proxy_debug model_raw:", preview);
    }
    let parsed = tryParseModelOutput(responseText, false);
    if (!parsed.ok) {
      // one retry with corrective message
      const corrective = {
        role: "assistant",
        content: "Return ONLY valid JSON following the schema. No extra text.",
      };
      responseText = await collectGlmResponse(chatId, [...glmMessages, corrective]);
      if (process.env.PROXY_DEBUG) {
        const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
        console.log("proxy_debug model_retry_raw:", preview);
      }
      parsed = tryParseModelOutput(responseText, false);
    }

    if (!parsed.ok) {
      const stricter = {
        role: "assistant",
        content: "Return ONLY valid JSON object. No markdown. No extra keys.",
      };
      responseText = await collectGlmResponse(chatId, [...glmMessages, stricter]);
      if (process.env.PROXY_DEBUG) {
        const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
        console.log("proxy_debug model_retry2_raw:", preview);
      }
      parsed = tryParseModelOutput(responseText, false);
    }

    if (!parsed.ok) {
      parsed = tryParseModelOutput(responseText, true);
      if (!parsed.ok && responseText !== initialResponseText) {
        parsed = tryParseModelOutput(initialResponseText, true);
      }
    }

    if (!parsed.ok || !parsed.data) {
      const repaired = tryRepairPlannerOutput(responseText);
      if (repaired) {
        parsed = { ok: true, data: repaired };
      }
    }

    if (!parsed.ok || !parsed.data) {
      const rawToolCalls = parseRawToolCalls(responseText, toolRegistry);
      if (rawToolCalls) {
        return sendToolCalls(reply, rawToolCalls, model, stream);
      }
      if (hasToolResult) {
        const looksLikePlannerJson = /"actions"\s*:|"tool"\s*:|"plan"\s*:/.test(responseText) || responseText.trim().startsWith("{");
        if (looksLikePlannerJson) {
          const finalMessages = [
            {
              role: "system",
              content: "Use the tool results above to answer the user. Return plain text only and do not call tools.",
            },
            ...convertMessages(messages, []),
          ];
          const finalText = await collectGlmResponse(chatId, finalMessages);
          if (stream) {
            reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
            reply.raw.write(streamContent(finalText, model));
            return reply.raw.end();
          }
          return reply.send(openaiContentResponse(finalText, model));
        }
      }
      if (hasToolResult && responseText.trim()) {
        if (stream) {
          reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
          reply.raw.write(streamContent(responseText, model));
          return reply.raw.end();
        }
        return reply.send(openaiContentResponse(responseText, model));
      }
      const fallbackTools = allowHeuristicTools
        ? inferApplyPatchToolCall(toolRegistry, lastUser) ||
          inferEditToolCall(toolRegistry, lastUser) ||
          inferReadToolCall(toolRegistry, lastUser) ||
          inferWriteToolCall(toolRegistry, lastUser) ||
          inferRunToolCall(toolRegistry, lastUser) ||
          inferListToolCall(toolRegistry, lastUser)
        : null;
      if (fallbackTools) {
        return sendToolCalls(reply, fallbackTools, model, stream);
      }
      const fallback = openaiContentResponse("Unable to generate tool call.", model);
      if (stream) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent("Unable to generate tool call.", model));
        return reply.raw.end();
      }
      return reply.send(fallback);
    }

    let parsedData = parsed.data;
    if (process.env.PROXY_DEBUG) {
      console.log("proxy_debug parsed_actions:", parsedData.actions.length);
      if (parsedData.actions.length) {
        console.log("proxy_debug action_tools:", parsedData.actions.map((a) => a.tool).join(","));
      }
    }

    if (hasToolResult && parsedData.actions.length > 0 && toolResultCount >= maxToolLoops) {
      const fallbackContent = parsedData.final || "Tool result received.";
      if (stream) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent(fallbackContent, model));
        return reply.raw.end();
      }
      return reply.send(openaiContentResponse(fallbackContent, model));
    }

    if (parsedData.actions.length === 0) {
      if (!hasToolResult) {
        const fallbackTools = allowHeuristicTools
          ? inferApplyPatchToolCall(toolRegistry, lastUser) ||
            inferEditToolCall(toolRegistry, lastUser) ||
            inferReadToolCall(toolRegistry, lastUser) ||
            inferWriteToolCall(toolRegistry, lastUser) ||
            inferRunToolCall(toolRegistry, lastUser) ||
            inferListToolCall(toolRegistry, lastUser)
          : null;
        if (fallbackTools) {
          return sendToolCalls(reply, fallbackTools, model, stream);
        }
      }
      const content = parsedData.final || "";
      if (stream) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent(content, model));
        return reply.raw.end();
      }
      return reply.send(openaiContentResponse(content, model));
    }

    const invalid = parsedData.actions.find((action) => !findTool(toolRegistry, action.tool));
    if (invalid) {
      const content = `Unknown tool: ${invalid.tool}`;
      if (stream) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent(content, model));
        return reply.raw.end();
      }
      return reply.send(openaiContentResponse(content, model));
    }

    const toolCalls = parsedData.actions.map((action, idx) => {
      const toolInfo = findTool(toolRegistry, action.tool);
      const toolName = toolInfo?.tool.function?.name || toolInfo?.tool.name || action.tool;
      const args = normalizeArgsForTool(toolInfo, action.args || {});
      return {
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        index: idx,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
      };
    });

    return sendToolCalls(reply, toolCalls, model, stream);
  }

  if (stream) {
    if (tools.length > 0 && !shouldAttemptTools) {
      const fullText = await collectGlmResponse(chatId, glmMessages);
      const rawToolCalls = parseRawToolCalls(fullText, toolRegistry);
      if (rawToolCalls) {
        return sendToolCalls(reply, rawToolCalls, model, true);
      }
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.write(streamContent(fullText, model));
      return reply.raw.end();
    }
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    let parentId: string | null = null;
    try {
      parentId = await client.getCurrentMessageId(chatId);
    } catch {
      parentId = null;
    }
    const generator = client.sendMessage({
      chatId,
      messages: glmMessages,
      includeHistory: false,
      enableThinking: false,
      parentMessageId: parentId,
    });
    const streamId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
    const created = Math.floor(Date.now() / 1000);
    let sentRole = false;
    for await (const chunk of generator) {
      if (chunk.type !== "content") continue;
      const payload = {
        id: streamId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: sentRole ? { content: chunk.data } : { role: "assistant", content: chunk.data },
            finish_reason: null,
          },
        ],
      };
      sentRole = true;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
    const finalPayload = {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    reply.raw.write(`data: ${JSON.stringify(finalPayload)}\n\n`);
    reply.raw.write("data: [DONE]\n\n");
    return reply.raw.end();
  }

  const content = await collectGlmResponse(chatId, glmMessages);
  if (tools.length > 0) {
    const rawToolCalls = parseRawToolCalls(content, toolRegistry);
    if (rawToolCalls) {
      return reply.send(openaiToolResponse(rawToolCalls, model));
    }
  }
  return reply.send(openaiContentResponse(content, model));
};

app.post("/v1/chat/completions", handleChatCompletion);
app.post("/chat/completions", handleChatCompletion);

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

app.listen({ port, host }).then(() => {
  console.log(`GLM proxy listening on http://${host}:${port}`);
});

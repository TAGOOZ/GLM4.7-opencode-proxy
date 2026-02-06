import { PROXY_DEBUG } from "../constants.js";

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

const normalizeToolName = (name: string) => name.toLowerCase().replace(/[_-]/g, "");

const NETWORK_TOOL_NAMES_NORM = new Set(["webfetch", "websearch"]);

const isNetworkToolName = (name: string): boolean => {
  return NETWORK_TOOL_NAMES_NORM.has(normalizeToolName(name));
};

const isNameMatch = (target: string, candidate: string) => {
  if (candidate === target) return true;
  if (candidate.startsWith(target)) return true;
  if (candidate === `${target}file`) return true;
  if (candidate === `${target}dir`) return true;
  return false;
};

const collectToolNames = (tool: ToolLike): string[] => {
  const names: string[] = [];
  const fn = tool.function || {};
  if (fn.name) names.push(fn.name);
  if (fn.tool?.name) names.push(fn.tool.name);
  if (tool.name) names.push(tool.name);
  return names;
};

const isNetworkTool = (tool: ToolLike): boolean => {
  return collectToolNames(tool).some((name) => isNetworkToolName(name));
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
        if (PROXY_DEBUG) {
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
  const command =
    normalized.command ??
    normalized.cmd ??
    args.command ??
    args.cmd;
  if (descKey && normalized[descKey] == null) {
    const detail =
      typeof command === "string" && command.trim()
        ? `run shell command: ${command.trim()}`
        : "run shell command";
    normalized[descKey] = detail;
  }
  if (!descKey) {
    const toolName = toolInfo?.tool?.function?.name || toolInfo?.tool?.name || "";
    const normalizedName = normalizeToolName(toolName);
    if ((normalizedName === "run" || normalizedName === "runshell" || normalizedName === "bash") && typeof command === "string") {
      normalized.description = normalized.description ?? `run shell command: ${command.trim()}`;
    }
  }
  if (toolInfo) {
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "";
    if (/webfetch/i.test(toolName)) {
      const format = String((normalized.format as string | undefined) ?? "").toLowerCase();
      if (!format || !["text", "markdown", "html"].includes(format)) {
        normalized.format = "text";
      }
    }
  }
  return normalized;
};

export {
  buildToolRegistry,
  findTool,
  isNetworkTool,
  isNetworkToolName,
  normalizeArgsForTool,
  type ToolInfo,
  type ToolLike,
};

import {
  DANGEROUS_COMMAND_PATTERNS,
  PROXY_ALLOW_NETWORK,
  PROXY_ALLOW_WEB_SEARCH,
  PROXY_MAX_ACTIONS_PER_TURN,
} from "../constants.js";
import { findTool, isNetworkToolName, type ToolInfo } from "../tools/registry.js";
import { isSensitivePath, isUnsafePathInput } from "../tools/pathSafety.js";
import { isProxyShellCommandAllowed } from "../tools/shellSafety.js";

const MAX_WRITE_CHARS = 200000;

const isSafeGlobPattern = (pattern: string): boolean => {
  const trimmed = pattern.trim();
  if (!trimmed) return true;
  const raw = trimmed.startsWith("!") ? trimmed.slice(1) : trimmed;
  if (!raw) return true;
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.startsWith("~")) return false;
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//")) return false;
  if (/(^|\/)\.\.(\/|$)/.test(normalized)) return false;
  if (/\{[^}]*\.\.[^}]*\}/.test(normalized)) return false;
  return true;
};

const MUTATION_TOOLS = new Set([
  "write",
  "write_file",
  "apply_patch",
  "patch",
  "edit",
  "run",
  "run_shell",
  "bash",
  "shell",
  "delete",
  "remove",
  "mkdir",
  "move",
  "mv",
]);

const RAW_TOOL_ALLOWLIST = new Set([
  "read",
  "read_file",
  "list",
  "list_dir",
  "glob",
  "grep",
  "search",
  "rg",
  "ripgrep",
]);

const normalizeToolName = (value: unknown) =>
  String(value || "").toLowerCase().replace(/[_-]/g, "");

const MUTATION_TOOLS_NORM = new Set([...MUTATION_TOOLS].map((t) => normalizeToolName(t)));
const RAW_TOOL_ALLOWLIST_NORM = new Set([...RAW_TOOL_ALLOWLIST].map((t) => normalizeToolName(t)));

const isRawToolCallsAllowed = (calls: any[]): boolean => {
  return calls.every((call) => {
    const toolName = normalizeToolName(call?.function?.name || call?.name || "");
    return RAW_TOOL_ALLOWLIST_NORM.has(toolName);
  });
};

const isMutationPlannerAction = (
  action: { tool: string },
  registry: Map<string, ToolInfo>,
): boolean => {
  const rawName = normalizeToolName(action?.tool || "");
  if (MUTATION_TOOLS_NORM.has(rawName)) return true;
  const toolInfo = findTool(registry, action?.tool || "");
  const resolvedName = normalizeToolName(
    toolInfo?.tool?.function?.name || toolInfo?.tool?.name || "",
  );
  return MUTATION_TOOLS_NORM.has(resolvedName);
};

const applyMutationActionBoundary = (
  actions: { tool: string; args: Record<string, unknown> }[],
  registry: Map<string, ToolInfo>,
): { actions: { tool: string; args: Record<string, unknown> }[]; truncated: boolean } => {
  if (actions.length <= 1) return { actions, truncated: false };
  const hasMutation = actions.some((action) => isMutationPlannerAction(action, registry));
  if (!hasMutation) return { actions, truncated: false };
  return { actions: actions.slice(0, 1), truncated: true };
};

type GuardResult =
  | { ok: true }
  | { ok: false; reason: string };

const validateToolCalls = (
  toolCalls: any[],
  source: "planner" | "raw" | "heuristic" | "explicit",
  registry: Map<string, ToolInfo>,
): GuardResult => {
  if (toolCalls.length > PROXY_MAX_ACTIONS_PER_TURN) {
    return { ok: false, reason: "too_many_actions" };
  }
  for (const call of toolCalls) {
    const toolName = normalizeToolName(call?.function?.name || call?.name || "");
    if (!PROXY_ALLOW_WEB_SEARCH && isNetworkToolName(toolName)) {
      return { ok: false, reason: "web_tools_disabled" };
    }
    const toolInfo = findTool(registry, toolName);
    let args: Record<string, unknown> = {};
    const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        return { ok: false, reason: "invalid_tool_args" };
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }

    if (toolInfo?.argKeys?.length) {
      const allowed = new Set(toolInfo.argKeys.map((k) => k.toLowerCase()));
      for (const key of Object.keys(args)) {
        if (!allowed.has(key.toLowerCase())) {
          return { ok: false, reason: "unexpected_arg" };
        }
      }
    }

    if (source !== "planner" && MUTATION_TOOLS_NORM.has(toolName)) {
      return { ok: false, reason: "mutation_requires_planner_json" };
    }

    if (toolName === "glob") {
      const pattern = String(args.pattern ?? "");
      if (!isSafeGlobPattern(pattern)) return { ok: false, reason: "path_outside_workspace" };
      continue;
    }

    if (
      toolName === "read" ||
      toolName === "readfile" ||
      toolName === "write" ||
      toolName === "writefile" ||
      toolName === "list" ||
      toolName === "listdir"
    ) {
      const pathValue = String(
        args.path ??
          args.filePath ??
          args.file_path ??
          args.dir ??
          "",
      ).trim();
      if (!pathValue) {
        return { ok: false, reason: "missing_path" };
      }
      if (isUnsafePathInput(pathValue)) {
        return { ok: false, reason: "path_outside_workspace" };
      }
      if (isSensitivePath(pathValue)) {
        return { ok: false, reason: "sensitive_path" };
      }
      if ((toolName === "write" || toolName === "writefile") && args.content != null) {
        const content = String(args.content);
        if (content.length > MAX_WRITE_CHARS) {
          return { ok: false, reason: "content_too_large" };
        }
      }
      continue;
    }

    if (
      toolName === "edit" ||
      toolName === "editfile" ||
      toolName === "applypatch" ||
      toolName === "patch"
    ) {
      const pathValue = String(args.path ?? args.filePath ?? args.file_path ?? "").trim();
      if (pathValue) {
        if (isUnsafePathInput(pathValue)) return { ok: false, reason: "path_outside_workspace" };
        if (isSensitivePath(pathValue)) return { ok: false, reason: "sensitive_path" };
      }
    }

    if (
      toolName === "run" ||
      toolName === "runshell" ||
      toolName === "bash" ||
      toolName === "shell"
    ) {
      const command = String(args.command ?? args.cmd ?? "").trim();
      if (!command) return { ok: false, reason: "missing_command" };
      if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
        return { ok: false, reason: "command_blocked" };
      }
      const allowCheck = isProxyShellCommandAllowed(command, PROXY_ALLOW_NETWORK);
      if (!allowCheck.ok) {
        return { ok: false, reason: "command_blocked" };
      }
      if (source !== "planner") {
        if (!/^(rg|ripgrep|grep)\b/i.test(command.trim())) {
          return { ok: false, reason: "mutation_requires_planner_json" };
        }
      }
    }
  }
  return { ok: true };
};

const validatePlannerActions = (
  actions: { tool: string; args: Record<string, unknown> }[],
): { ok: boolean; reason?: string } => {
  if (actions.length > PROXY_MAX_ACTIONS_PER_TURN) {
    return { ok: false, reason: "too_many_actions" };
  }
  const seen = new Set<string>();
  for (const action of actions) {
    const key = `${action.tool}|${JSON.stringify(action.args ?? {})}`;
    if (seen.has(key)) {
      return { ok: false, reason: "duplicate_actions" };
    }
    seen.add(key);
  }
  return { ok: true };
};

export {
  applyMutationActionBoundary,
  isRawToolCallsAllowed,
  validatePlannerActions,
  validateToolCalls,
  type GuardResult,
};


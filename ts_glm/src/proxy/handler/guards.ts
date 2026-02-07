import fs from "fs";
import path from "path";
import {
  DANGEROUS_COMMAND_PATTERNS,
  PROXY_ALLOW_ANY_COMMAND,
  PROXY_ALLOW_EXPLICIT_MUTATIONS,
  PROXY_ALLOW_NETWORK,
  PROXY_ALLOW_RAW_MUTATIONS,
  PROXY_ALLOW_WEB_SEARCH,
  PROXY_CONFIRM_DANGEROUS_COMMANDS,
  PROXY_MAX_ACTIONS_PER_TURN,
} from "../constants.js";
import { findTool, isNetworkToolName, type ToolInfo } from "../tools/registry.js";
import { pickArgKey } from "../tools/inferUtils.js";
import { normalizeJsonCandidate, parseRawJson } from "../tools/parseJson.js";
import {
  getWorkspaceRoots,
  isSensitivePath,
  isUnsafePathInput,
  normalizePathForWorkspace,
} from "../tools/pathSafety.js";
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
  // Safe/non-mutating OpenCode tools that models often emit as raw tool_calls arrays.
  // We still run validateToolCalls() after parsing; this list is just the early gate.
  "question",
  "read",
  "read_file",
  "list",
  "list_dir",
  "glob",
  "grep",
  "task",
  "search",
  "rg",
  "ripgrep",
  "todoread",
  "todowrite",
  "webfetch",
  "websearch",
]);

const normalizeToolName = (value: unknown) =>
  String(value || "").toLowerCase().replace(/[_-]/g, "");

const MUTATION_TOOLS_NORM = new Set([...MUTATION_TOOLS].map((t) => normalizeToolName(t)));
const RAW_TOOL_ALLOWLIST_NORM = new Set([...RAW_TOOL_ALLOWLIST].map((t) => normalizeToolName(t)));

const isRawToolCallsAllowed = (calls: any[]): boolean => {
  return calls.every((call) => {
    const toolName = normalizeToolName(call?.function?.name || call?.name || "");
    if (RAW_TOOL_ALLOWLIST_NORM.has(toolName)) return true;
    if (PROXY_ALLOW_RAW_MUTATIONS && MUTATION_TOOLS_NORM.has(toolName)) return true;
    return false;
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
  | {
      ok: false;
      reason: string;
      confirmationToolCalls?: any[];
      pendingConfirmation?: { id: string; toolCalls: any[]; blockedReason: string };
    };

const CONFIRM_TOOL_NAMES = [
  "question",
  "askquestion",
  "ask_question",
  "confirm",
  "confirm_action",
  "request_confirmation",
];

const buildConfirmationToolCall = (
  registry: Map<string, ToolInfo>,
  question: string,
): any[] | null => {
  const buildQuestionsArgs = () => ({
    questions: [
      {
        header: "Confirm",
        id: `confirm_${Math.random().toString(36).slice(2, 10)}`,
        question,
        options: [
          {
            label: "Proceed (Recommended)",
            description: "Approve the action and continue.",
          },
          {
            label: "Cancel",
            description: "Decline the action and stop.",
          },
        ],
      },
    ],
  });
  for (const name of CONFIRM_TOOL_NAMES) {
    const toolInfo = findTool(registry, name);
    if (!toolInfo) continue;
    const argKeys = new Set((toolInfo.argKeys || []).map((k) => k.toLowerCase()));
    const key = pickArgKey(toolInfo, ["question", "prompt", "text", "message", "input", "questions"]);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || name;
    const args =
      key === "questions" || argKeys.has("questions")
        ? buildQuestionsArgs()
        : { [key]: question };
    return [
      {
        id: `call_confirm_${Math.random().toString(36).slice(2, 8)}`,
        index: 0,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
      },
    ];
  }
  return null;
};

const WORKSPACE_ROOTS = getWorkspaceRoots();

const getPathArgKey = (args: Record<string, unknown>): string | null => {
  if (args.path != null) return "path";
  if (args.filePath != null) return "filePath";
  if (args.file_path != null) return "file_path";
  if (args.dir != null) return "dir";
  return null;
};

const getWorkdirArgKey = (args: Record<string, unknown>): string | null => {
  if (args.workdir != null) return "workdir";
  if (args.cwd != null) return "cwd";
  if (args.directory != null) return "directory";
  return null;
};

const isExistingDirectory = (candidate: string): boolean => {
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

const resolveExistingDirectory = (candidate: string, workspaceRoots: string[]): string | null => {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string) => {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push(resolved);
  };
  if (path.isAbsolute(candidate)) {
    addCandidate(candidate);
  } else {
    for (const root of workspaceRoots) {
      addCandidate(path.resolve(root, candidate));
    }
    addCandidate(path.resolve(process.cwd(), candidate));
  }
  for (const resolved of candidates) {
    if (isExistingDirectory(resolved)) return resolved;
  }
  return null;
};

const rewriteToolCallArgs = (call: any, args: Record<string, unknown>) => {
  if (!call || typeof call !== "object") return;
  if (!call.function || typeof call.function !== "object") return;
  call.function.arguments = JSON.stringify(args);
};

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

const NON_CONFIRMABLE_GUARD_REASONS = new Set([
  "invalid_tool_args",
  "unexpected_arg",
  "missing_path",
  "missing_command",
  "missing_content",
  "invalid_content_type",
]);

const confirmOrBlock = (
  registry: Map<string, ToolInfo>,
  blockedReason: string,
  question: string,
  toolCallsToReplay: any[],
): GuardResult => {
  if (NON_CONFIRMABLE_GUARD_REASONS.has(blockedReason)) {
    return { ok: false, reason: blockedReason };
  }
  const confirmationToolCalls = buildConfirmationToolCall(registry, question);
  if (confirmationToolCalls && confirmationToolCalls.length > 0) {
    const id = String(confirmationToolCalls[0]?.id || "");
    return {
      ok: false,
      reason: "confirmation_required",
      confirmationToolCalls,
      pendingConfirmation: {
        id,
        toolCalls: toolCallsToReplay,
        blockedReason,
      },
    };
  }
  return { ok: false, reason: blockedReason };
};

const isNetworkRestrictedCommand = (command: string, allowNetwork: boolean): boolean => {
  if (allowNetwork) return false;
  if (/(https?:\/\/|\bssh\b|\bscp\b|\bftp\b)/i.test(command)) return true;
  if (/\bgit\s+clone\b|\bnpm\s+install\b|\bpnpm\s+install\b|\byarn\s+add\b|\bpip\s+install\b/i.test(command)) {
    return true;
  }
  return false;
};

const isDangerousCommand = (command: string): boolean => {
  if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) return true;
  if (/^\s*rm\b/i.test(command)) return true;
  if (/^\s*rmdir\b/i.test(command)) return true;
  if (/^\s*del\b/i.test(command)) return true;
  return false;
};

const validateToolCalls = (
  toolCalls: any[],
  source: "planner" | "raw" | "heuristic" | "explicit",
  registry: Map<string, ToolInfo>,
): GuardResult => {
  if (toolCalls.length > PROXY_MAX_ACTIONS_PER_TURN) {
    return confirmOrBlock(
      registry,
      "too_many_actions",
      `Confirm executing ${PROXY_MAX_ACTIONS_PER_TURN} action(s) out of ${toolCalls.length}.`,
      toolCalls.slice(0, PROXY_MAX_ACTIONS_PER_TURN),
    );
  }
  const allowMutationFromSource =
    source === "planner" ||
    (source === "explicit" && PROXY_ALLOW_EXPLICIT_MUTATIONS) ||
    (source === "raw" && PROXY_ALLOW_RAW_MUTATIONS);
  for (const call of toolCalls) {
    const toolName = normalizeToolName(call?.function?.name || call?.name || "");
    if (!PROXY_ALLOW_WEB_SEARCH && isNetworkToolName(toolName)) {
      return confirmOrBlock(
        registry,
        "web_tools_disabled",
        `Confirm overriding guard "web_tools_disabled" for tool "${toolName}".`,
        toolCalls,
      );
    }
    const toolInfo = findTool(registry, toolName);
    let args: Record<string, unknown> = {};
    const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
    const parsedArgs = parseToolCallArguments(rawArgs);
    if (!parsedArgs.ok) {
      return confirmOrBlock(
        registry,
        "invalid_tool_args",
        `Confirm overriding guard "invalid_tool_args" for tool "${toolName}" (arguments were not valid JSON).`,
        toolCalls,
      );
    }
    args = parsedArgs.args;
    if (parsedArgs.rewritten) {
      rewriteToolCallArgs(call, args);
    }

    if (toolInfo?.argKeys?.length) {
      const allowed = new Set(toolInfo.argKeys.map((k) => k.toLowerCase()));
      for (const key of Object.keys(args)) {
        if (!allowed.has(key.toLowerCase())) {
          return confirmOrBlock(
            registry,
            "unexpected_arg",
            `Confirm overriding guard "unexpected_arg" for tool "${toolName}" with args ${summarizeArgs(args)}.`,
            toolCalls,
          );
        }
      }
    }

    if (!allowMutationFromSource && MUTATION_TOOLS_NORM.has(toolName)) {
      return confirmOrBlock(
        registry,
        "mutation_requires_planner_json",
        `Confirm overriding guard "mutation_requires_planner_json" for tool "${toolName}" with args ${summarizeArgs(args)}.`,
        toolCalls,
      );
    }

    if (toolName === "glob") {
      const pattern = String(args.pattern ?? "");
      if (!isSafeGlobPattern(pattern)) {
        return confirmOrBlock(
          registry,
          "path_outside_workspace",
          `Confirm overriding guard "path_outside_workspace" for glob pattern: ${JSON.stringify(truncateValue(pattern))}`,
          toolCalls,
        );
      }
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
        return confirmOrBlock(
          registry,
          "missing_path",
          `Confirm overriding guard "missing_path" for tool "${toolName}" with args ${summarizeArgs(args)}.`,
          toolCalls,
        );
      }
      const normalizedPathValue = normalizePathForWorkspace(pathValue, WORKSPACE_ROOTS);
      if (normalizedPathValue !== pathValue) {
        const key = getPathArgKey(args);
        if (key) {
          args[key] = normalizedPathValue;
          rewriteToolCallArgs(call, args);
        }
      }
      if (
        isUnsafePathInput(normalizedPathValue, {
          allowAbsoluteInWorkspace: true,
          workspaceRoots: WORKSPACE_ROOTS,
        })
      ) {
        return confirmOrBlock(
          registry,
          "path_outside_workspace",
          `Confirm overriding guard "path_outside_workspace" for tool "${toolName}" with path ${JSON.stringify(truncateValue(normalizedPathValue))}.`,
          toolCalls,
        );
      }
      if (isSensitivePath(normalizedPathValue)) {
        return confirmOrBlock(
          registry,
          "sensitive_path",
          `Confirm overriding guard "sensitive_path" for tool "${toolName}" with path ${JSON.stringify(truncateValue(normalizedPathValue))}.`,
          toolCalls,
        );
      }
      if ((toolName === "write" || toolName === "writefile") && args.content != null) {
        if (typeof args.content !== "string") {
          return confirmOrBlock(
            registry,
            "invalid_content_type",
            `Confirm overriding guard "invalid_content_type" for tool "${toolName}" with args ${summarizeArgs(args)}.`,
            toolCalls,
          );
        }
        const content = args.content;
        if (content.length > MAX_WRITE_CHARS) {
          return confirmOrBlock(
            registry,
            "content_too_large",
            `Confirm overriding guard "content_too_large" for tool "${toolName}" (content length ${content.length}, max ${MAX_WRITE_CHARS}).`,
            toolCalls,
          );
        }
      } else if (toolName === "write" || toolName === "writefile") {
        return confirmOrBlock(
          registry,
          "missing_content",
          `Confirm overriding guard "missing_content" for tool "${toolName}" with args ${summarizeArgs(args)}.`,
          toolCalls,
        );
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
        const normalizedPathValue = normalizePathForWorkspace(pathValue, WORKSPACE_ROOTS);
        if (normalizedPathValue !== pathValue) {
          const key = getPathArgKey(args);
          if (key) {
            args[key] = normalizedPathValue;
            rewriteToolCallArgs(call, args);
          }
        }
        if (
          isUnsafePathInput(normalizedPathValue, {
            allowAbsoluteInWorkspace: true,
            workspaceRoots: WORKSPACE_ROOTS,
          })
        ) {
          return confirmOrBlock(
            registry,
            "path_outside_workspace",
            `Confirm overriding guard "path_outside_workspace" for tool "${toolName}" with path ${JSON.stringify(truncateValue(normalizedPathValue))}.`,
            toolCalls,
          );
        }
        if (isSensitivePath(normalizedPathValue)) {
          return confirmOrBlock(
            registry,
            "sensitive_path",
            `Confirm overriding guard "sensitive_path" for tool "${toolName}" with path ${JSON.stringify(truncateValue(normalizedPathValue))}.`,
            toolCalls,
          );
        }
      }
    }

    if (
      toolName === "run" ||
      toolName === "runshell" ||
      toolName === "bash" ||
      toolName === "shell"
    ) {
      const workdirKey = getWorkdirArgKey(args);
      if (workdirKey) {
        const rawWorkdir = args[workdirKey];
        if (typeof rawWorkdir !== "string" || !rawWorkdir.trim()) {
          delete args[workdirKey];
          rewriteToolCallArgs(call, args);
        } else {
          const workdirInput = rawWorkdir.trim();
          const normalizedWorkdir = normalizePathForWorkspace(workdirInput, WORKSPACE_ROOTS);
          const workdirUnsafe =
            isUnsafePathInput(workdirInput, {
              allowAbsoluteInWorkspace: true,
              workspaceRoots: WORKSPACE_ROOTS,
            }) || isSensitivePath(normalizedWorkdir);
          let resolvedWorkdir: string | null = null;
          if (!workdirUnsafe) {
            if (path.isAbsolute(workdirInput)) {
              const absoluteWorkdir = path.resolve(workdirInput);
              resolvedWorkdir = isExistingDirectory(absoluteWorkdir) ? absoluteWorkdir : null;
            } else {
              resolvedWorkdir = resolveExistingDirectory(workdirInput, WORKSPACE_ROOTS);
            }
          }
          if (!resolvedWorkdir) {
            delete args[workdirKey];
            rewriteToolCallArgs(call, args);
          } else if (resolvedWorkdir !== workdirInput) {
            args[workdirKey] = resolvedWorkdir;
            rewriteToolCallArgs(call, args);
          }
        }
      }

      const command = String(args.command ?? args.cmd ?? "").trim();
      if (!command) {
        return confirmOrBlock(
          registry,
          "missing_command",
          `Confirm overriding guard "missing_command" for tool "${toolName}" with args ${summarizeArgs(args)}.`,
          toolCalls,
        );
      }
      if (isDangerousCommand(command) && PROXY_CONFIRM_DANGEROUS_COMMANDS) {
        return confirmOrBlock(
          registry,
          "dangerous_command",
          `Confirm running dangerous command: ${truncateValue(command)}`,
          toolCalls,
        );
      }
      if (isNetworkRestrictedCommand(command, PROXY_ALLOW_NETWORK)) {
        return confirmOrBlock(
          registry,
          "network_disabled",
          `Confirm overriding guard "network_disabled" for command: ${JSON.stringify(truncateValue(command))}`,
          toolCalls,
        );
      }
      if (!PROXY_ALLOW_ANY_COMMAND) {
        const allowCheck = isProxyShellCommandAllowed(command, PROXY_ALLOW_NETWORK);
        if (!allowCheck.ok) {
          return confirmOrBlock(
            registry,
            "command_blocked",
            `Confirm overriding guard "command_blocked" for command: ${JSON.stringify(truncateValue(command))}`,
            toolCalls,
          );
        }
      }
      if (!allowMutationFromSource) {
        if (!/^(rg|ripgrep|grep)\b/i.test(command.trim())) {
          return confirmOrBlock(
            registry,
            "mutation_requires_planner_json",
            `Confirm overriding guard "mutation_requires_planner_json" for command: ${JSON.stringify(truncateValue(command))}`,
            toolCalls,
          );
        }
      }
    }

    if (toolName === "delete" || toolName === "remove" || toolName === "rm") {
      if (PROXY_CONFIRM_DANGEROUS_COMMANDS) {
        const target = String(
          args.path ??
            args.filePath ??
            args.file_path ??
            args.target ??
            "",
        ).trim();
        const question = target
          ? `Confirm deleting: ${target}`
          : "Confirm delete action.";
        return confirmOrBlock(registry, "delete_confirm", question, toolCalls);
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

import path from "path";
import {
  PROXY_ALLOW_ANY_COMMAND,
  PROXY_ALLOW_EXPLICIT_MUTATIONS,
  PROXY_ALLOW_NETWORK,
  PROXY_ALLOW_RAW_MUTATIONS,
  PROXY_ALLOW_WEB_SEARCH,
  PROXY_CONFIRM_DANGEROUS_COMMANDS,
  PROXY_MAX_ACTIONS_PER_TURN,
} from "../constants.js";
import { findTool, isNetworkToolName, type ToolInfo } from "../tools/registry.js";
import { isProxyShellCommandAllowed } from "../tools/shellSafety.js";
import { MUTATION_TOOLS_NORM, normalizeToolName } from "./guardMutation.js";
import {
  parseToolCallArguments,
  rewriteToolCallArgs,
  summarizeArgs,
  truncateValue,
} from "./guardValidation/args.js";
import { confirmOrBlock, type GuardResult } from "./guardValidation/confirm.js";
import {
  WORKSPACE_ROOTS,
  getPathArgKey,
  getWorkdirArgKey,
  isExistingDirectory,
  isSafeGlobPattern,
  isSensitivePath,
  isUnsafePathInput,
  normalizePathForWorkspace,
  resolveExistingDirectory,
} from "./guardValidation/pathUtils.js";
import {
  isDangerousCommand,
  isNetworkRestrictedCommand,
  isReadOnlySearchCommand,
} from "./guardValidation/commandUtils.js";

const MAX_WRITE_CHARS = 200000;
const QUESTION_TOOL_NAMES_NORM = new Set(["question", "askquestion", "ask_question", "confirm"]);
const GUARD_CONFIRMATION_QUESTION_REGEX =
  /\bconfirm overriding guard\b|\b(command_blocked|dangerous_command|network_disabled|mutation_requires_planner_json|path_outside_workspace|sensitive_path|delete_confirm)\b/i;

const extractQuestionPrompt = (args: Record<string, unknown>): string => {
  for (const key of ["question", "prompt", "text", "message", "input"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const questions = args.questions;
  if (Array.isArray(questions)) {
    for (const item of questions) {
      if (!item || typeof item !== "object") continue;
      const candidate =
        (item as Record<string, unknown>).question ??
        (item as Record<string, unknown>).prompt ??
        (item as Record<string, unknown>).text;
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }
  if (typeof questions === "string" && questions.trim()) return questions;
  return "";
};

const buildDefaultQuestionOptions = () => [
  {
    label: "Proceed (Recommended)",
    description: "Approve the action and continue.",
  },
  {
    label: "Cancel",
    description: "Decline the action and stop.",
  },
];

const normalizeQuestionOptions = (value: unknown): Array<{ label: string; description: string }> => {
  if (!Array.isArray(value) || value.length === 0) return buildDefaultQuestionOptions();
  const normalized = value
    .map((item, idx) => {
      if (item && typeof item === "object") {
        const candidate = item as Record<string, unknown>;
        const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
        const description =
          typeof candidate.description === "string" && candidate.description.trim()
            ? candidate.description.trim()
            : idx === 0
              ? "Approve the action and continue."
              : "Decline the action and stop.";
        if (label) return { label, description };
      }
      if (typeof item === "string" && item.trim()) {
        return {
          label: item.trim(),
          description: idx === 0 ? "Approve the action and continue." : "Choose this option.",
        };
      }
      return null;
    })
    .filter(Boolean) as Array<{ label: string; description: string }>;
  return normalized.length > 0 ? normalized : buildDefaultQuestionOptions();
};

const normalizeQuestionToolArgs = (
  args: Record<string, unknown>,
  toolInfo: ToolInfo | null,
): { args: Record<string, unknown>; changed: boolean } => {
  const declaredKeys = new Set((toolInfo?.argKeys || []).map((key) => String(key)));
  const expectsQuestions = declaredKeys.has("questions");
  const allowsQuestion = declaredKeys.has("question");
  const fallbackPrompt = extractQuestionPrompt(args) || "Please confirm.";
  let changed = false;

  if (expectsQuestions) {
    const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
    const sourceQuestions = rawQuestions.length > 0 ? rawQuestions : [{ question: fallbackPrompt }];
    const normalizedQuestions = sourceQuestions.map((item) => {
      const candidate = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const question =
        typeof candidate.question === "string" && candidate.question.trim()
          ? candidate.question.trim()
          : typeof candidate.prompt === "string" && candidate.prompt.trim()
            ? candidate.prompt.trim()
            : typeof candidate.text === "string" && candidate.text.trim()
              ? candidate.text.trim()
              : fallbackPrompt;
      const header =
        typeof candidate.header === "string" && candidate.header.trim()
          ? candidate.header.trim()
          : "Confirm";
      const id =
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : `confirm_${Math.random().toString(36).slice(2, 10)}`;
      const options = normalizeQuestionOptions(candidate.options);
      return { header, id, question, options };
    });
    const serializedBefore = JSON.stringify(args.questions ?? null);
    const serializedAfter = JSON.stringify(normalizedQuestions);
    if (serializedBefore !== serializedAfter) {
      args.questions = normalizedQuestions;
      changed = true;
    }
    if ("question" in args && !declaredKeys.has("question")) {
      delete args.question;
      changed = true;
    }
    return { args, changed };
  }

  if (allowsQuestion && typeof args.question !== "string") {
    args.question = fallbackPrompt;
    changed = true;
  }

  return { args, changed };
};

const normalizePatchPath = (value: string): string | null => {
  const trimmed = value.trim().replace(/^['"`]|['"`]$/g, "");
  if (!trimmed || trimmed === "/dev/null") return null;
  return trimmed;
};

const extractPatchPaths = (value: unknown): string[] => {
  if (typeof value !== "string" || !value.trim()) return [];
  const paths = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const normalized = normalizePatchPath(raw);
    if (normalized) paths.add(normalized);
  };
  for (const match of value.matchAll(/^\s*\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/gm)) {
    add(match[1]);
  }
  for (const match of value.matchAll(/^\s*diff --git a\/.+ b\/(.+)$/gm)) {
    add(match[1]);
  }
  for (const match of value.matchAll(/^\s*\+\+\+\s+b\/(.+)$/gm)) {
    add(match[1]);
  }
  return [...paths];
};

const validatePathValue = (params: {
  pathValue: string;
  toolName: string;
  toolCalls: any[];
  registry: Map<string, ToolInfo>;
  label?: string;
}): { normalizedPathValue: string; guard: GuardResult | null } => {
  const { pathValue, toolName, toolCalls, registry, label = "path" } = params;
  const normalizedPathValue = normalizePathForWorkspace(pathValue, WORKSPACE_ROOTS);
  if (
    isUnsafePathInput(normalizedPathValue, {
      allowAbsoluteInWorkspace: true,
      workspaceRoots: WORKSPACE_ROOTS,
    })
  ) {
    return {
      normalizedPathValue,
      guard: confirmOrBlock(
        registry,
        "path_outside_workspace",
        `Confirm overriding guard "path_outside_workspace" for tool "${toolName}" with ${label} ${JSON.stringify(truncateValue(normalizedPathValue))}.`,
        toolCalls,
      ),
    };
  }
  if (isSensitivePath(normalizedPathValue)) {
    return {
      normalizedPathValue,
      guard: confirmOrBlock(
        registry,
        "sensitive_path",
        `Confirm overriding guard "sensitive_path" for tool "${toolName}" with ${label} ${JSON.stringify(truncateValue(normalizedPathValue))}.`,
        toolCalls,
      ),
    };
  }
  return { normalizedPathValue, guard: null };
};

const validateAndRewritePath = (params: {
  call: any;
  args: Record<string, unknown>;
  pathValue: string;
  toolName: string;
  toolCalls: any[];
  registry: Map<string, ToolInfo>;
}): GuardResult | null => {
  const { call, args, pathValue, toolName, toolCalls, registry } = params;
  const pathValidation = validatePathValue({
    pathValue,
    toolName,
    toolCalls,
    registry,
  });
  if (pathValidation.guard) return pathValidation.guard;
  if (pathValidation.normalizedPathValue !== pathValue) {
    const key = getPathArgKey(args);
    if (key) {
      args[key] = pathValidation.normalizedPathValue;
      rewriteToolCallArgs(call, args);
    }
  }
  return null;
};

const resolvePreferredPathArgKey = (
  args: Record<string, unknown>,
  toolInfo: ToolInfo | null,
): string => {
  const existing = getPathArgKey(args);
  if (existing) return existing;
  const declared = toolInfo?.argKeys || [];
  for (const candidate of ["path", "filePath", "file_path", "dir"]) {
    if (declared.includes(candidate)) return candidate;
  }
  return "path";
};

const dropUnexpectedArgs = (params: {
  call: any;
  args: Record<string, unknown>;
  toolInfo: ToolInfo | null;
}): void => {
  const { call, args, toolInfo } = params;
  if (!toolInfo?.argKeys?.length) return;
  const allowed = new Set(toolInfo.argKeys.map((k) => normalizeToolName(k)));
  let changed = false;
  for (const key of Object.keys(args)) {
    if (allowed.has(normalizeToolName(key))) continue;
    delete args[key];
    changed = true;
  }
  if (changed) {
    rewriteToolCallArgs(call, args);
  }
};

const validateToolCalls = (
  toolCalls: any[],
  source: "planner" | "raw" | "heuristic" | "explicit",
  registry: Map<string, ToolInfo>,
  requiredToolName?: string | null,
): GuardResult => {
  if (PROXY_MAX_ACTIONS_PER_TURN > 0 && toolCalls.length > PROXY_MAX_ACTIONS_PER_TURN) {
    return confirmOrBlock(
      registry,
      "too_many_actions",
      `Confirm executing ${toolCalls.length} action(s) (configured max: ${PROXY_MAX_ACTIONS_PER_TURN}).`,
      toolCalls,
    );
  }
  const allowMutationFromSource =
    source === "planner" ||
    (source === "explicit" && PROXY_ALLOW_EXPLICIT_MUTATIONS) ||
    (source === "raw" && PROXY_ALLOW_RAW_MUTATIONS);
  const requiredToolNorm = requiredToolName ? normalizeToolName(requiredToolName) : null;
  for (const call of toolCalls) {
    const toolName = normalizeToolName(call?.function?.name || call?.name || "");
    const isShellTool =
      toolName === "run" ||
      toolName === "runshell" ||
      toolName === "bash" ||
      toolName === "shell";
    if (!PROXY_ALLOW_WEB_SEARCH && isNetworkToolName(toolName)) {
      return confirmOrBlock(
        registry,
        "web_tools_disabled",
        `Confirm overriding guard "web_tools_disabled" for tool "${toolName}".`,
        toolCalls,
      );
    }
    const toolInfo = findTool(registry, toolName);
    const resolvedToolName = normalizeToolName(
      toolInfo?.tool?.function?.name || toolInfo?.tool?.name || toolName,
    );
    if (requiredToolNorm && resolvedToolName !== requiredToolNorm) {
      return confirmOrBlock(
        registry,
        "tool_choice_mismatch",
        `Confirm overriding tool_choice mismatch (required "${requiredToolName}", got "${resolvedToolName || toolName}").`,
        toolCalls,
      );
    }
    let args: Record<string, unknown> = {};
    const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
    const parsedArgs = parseToolCallArguments(rawArgs, toolName);
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

    if (QUESTION_TOOL_NAMES_NORM.has(toolName)) {
      const normalizedQuestionArgs = normalizeQuestionToolArgs(args, toolInfo);
      args = normalizedQuestionArgs.args;
      if (normalizedQuestionArgs.changed) {
        rewriteToolCallArgs(call, args);
      }
    }

    if (QUESTION_TOOL_NAMES_NORM.has(toolName)) {
      const prompt = extractQuestionPrompt(args);
      if (prompt && GUARD_CONFIRMATION_QUESTION_REGEX.test(prompt)) {
        return { ok: false, reason: "reserved_confirmation_prompt" };
      }
    }

    dropUnexpectedArgs({ call, args, toolInfo });

    if (!allowMutationFromSource && MUTATION_TOOLS_NORM.has(toolName) && !isShellTool) {
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
      let pathValue = String(
        args.path ??
          args.filePath ??
          args.file_path ??
          args.dir ??
          "",
      ).trim();
      if (!pathValue) {
        if (
          toolName === "list" ||
          toolName === "listdir" ||
          toolName === "read" ||
          toolName === "readfile"
        ) {
          const pathKey = resolvePreferredPathArgKey(args, toolInfo);
          args[pathKey] = ".";
          pathValue = ".";
          rewriteToolCallArgs(call, args);
        } else {
          return confirmOrBlock(
            registry,
            "missing_path",
            `Confirm overriding guard "missing_path" for tool "${toolName}" with args ${summarizeArgs(args)}.`,
            toolCalls,
          );
        }
      }
      const pathGuard = validateAndRewritePath({
        call,
        args,
        pathValue,
        toolName,
        toolCalls,
        registry,
      });
      if (pathGuard) return pathGuard;
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

    if (toolName === "edit" || toolName === "editfile") {
      const pathValue = String(args.path ?? args.filePath ?? args.file_path ?? "").trim();
      if (pathValue) {
        const pathGuard = validateAndRewritePath({
          call,
          args,
          pathValue,
          toolName,
          toolCalls,
          registry,
        });
        if (pathGuard) return pathGuard;
      }
    }

    if (toolName === "applypatch" || toolName === "patch") {
      const pathValue = String(args.path ?? args.filePath ?? args.file_path ?? "").trim();
      if (pathValue) {
        const pathGuard = validateAndRewritePath({
          call,
          args,
          pathValue,
          toolName,
          toolCalls,
          registry,
        });
        if (pathGuard) return pathGuard;
      }

      const patchPaths = extractPatchPaths(args.patch ?? args.input ?? args.diff ?? args.changes);
      for (const patchPath of patchPaths) {
        const patchPathValidation = validatePathValue({
          pathValue: patchPath,
          toolName,
          toolCalls,
          registry,
          label: "patch path",
        });
        if (patchPathValidation.guard) {
          return patchPathValidation.guard;
        }
      }
    }

    if (isShellTool) {
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
        if (!isReadOnlySearchCommand(command)) {
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
  if (PROXY_MAX_ACTIONS_PER_TURN > 0 && actions.length > PROXY_MAX_ACTIONS_PER_TURN) {
    return { ok: false, reason: "too_many_actions" };
  }
  return { ok: true };
};

export { validatePlannerActions, validateToolCalls, type GuardResult };

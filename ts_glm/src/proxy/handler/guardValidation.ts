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
import { isDangerousCommand, isNetworkRestrictedCommand } from "./guardValidation/commandUtils.js";

const MAX_WRITE_CHARS = 200000;

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

export { validatePlannerActions, validateToolCalls, type GuardResult };

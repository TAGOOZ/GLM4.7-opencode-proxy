import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import fg from "fast-glob";

import type { ToolContext, ToolResult, ToolRunner } from "./types.js";
import { isCommandAllowed, truncateOutput } from "./safety.js";

const resolveSafePath = (cwd: string, target: string): string => {
  const base = path.resolve(cwd);
  const resolved = path.resolve(base, target);
  const relative = path.relative(base, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error("path_outside_workspace");
};

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

export const runShellTool = (allowlist: string[], denylist: RegExp[]): ToolRunner => ({
  name: "run_shell",
  run: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return { tool: "run_shell", ok: false, error: "unsafe_root" };
    }
    const command = String(args.command || args.cmd || "").trim();
    if (!command) {
      return { tool: "run_shell", ok: false, error: "missing_command" };
    }

    const allowCheck = isCommandAllowed(command, {
      maxIterations: 0,
      maxActionsPerTurn: 0,
      timeoutMs: ctx.timeoutMs,
      strictJson: true,
      allowNetwork: ctx.allowNetwork,
      allowlistCommands: allowlist,
      denylistPatterns: denylist,
      redactPatterns: [],
    });

    if (!allowCheck.ok) {
      return { tool: "run_shell", ok: false, error: "command_blocked", reason: allowCheck.reason };
    }

    return await new Promise((resolve) => {
      const child = spawn(command, {
        cwd: ctx.cwd,
        shell: true,
        env: process.env,
        timeout: ctx.timeoutMs,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => (stdout += data.toString()));
      child.stderr.on("data", (data) => (stderr += data.toString()));
      child.on("close", (code) => {
        const truncOut = truncateOutput(stdout);
        const truncErr = truncateOutput(stderr);
        resolve({
          tool: "run_shell",
          ok: code === 0,
          stdout: truncOut.value,
          stderr: truncErr.value,
          code,
          truncated: truncOut.truncated || truncErr.truncated,
        });
      });
    });
  }
});

export const readFileTool: ToolRunner = {
  name: "read_file",
  run: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return { tool: "read_file", ok: false, error: "unsafe_root" };
    }
    const filePath = String(args.path || args.filePath || args.file_path || "").trim();
    if (!filePath) {
      return { tool: "read_file", ok: false, error: "missing_path" };
    }
    try {
      const resolved = resolveSafePath(ctx.cwd, filePath);
      const content = await fs.readFile(resolved, "utf-8");
      const trunc = truncateOutput(content);
      return { tool: "read_file", ok: true, content: trunc.value, truncated: trunc.truncated };
    } catch (err) {
      return { tool: "read_file", ok: false, error: (err as Error).message };
    }
  }
};

export const writeFileTool: ToolRunner = {
  name: "write_file",
  run: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return { tool: "write_file", ok: false, error: "unsafe_root" };
    }
    const filePath = String(args.path || args.filePath || args.file_path || "").trim();
    const content = String(args.content ?? "");
    if (!filePath) {
      return { tool: "write_file", ok: false, error: "missing_path" };
    }
    try {
      const resolved = resolveSafePath(ctx.cwd, filePath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf-8");
      return { tool: "write_file", ok: true };
    } catch (err) {
      return { tool: "write_file", ok: false, error: (err as Error).message };
    }
  }
};

export const listDirTool: ToolRunner = {
  name: "list_dir",
  run: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return { tool: "list_dir", ok: false, error: "unsafe_root" };
    }
    const dirPath = String(args.path || args.dir || ".").trim() || ".";
    try {
      const resolved = resolveSafePath(ctx.cwd, dirPath);
      const entries = await fs.readdir(resolved);
      return { tool: "list_dir", ok: true, entries };
    } catch (err) {
      return { tool: "list_dir", ok: false, error: (err as Error).message };
    }
  }
};

export const globTool: ToolRunner = {
  name: "glob",
  run: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return { tool: "glob", ok: false, error: "unsafe_root" };
    }
    const pattern = String(args.pattern || "**/*");
    if (!isSafeGlobPattern(pattern)) {
      return { tool: "glob", ok: false, error: "path_outside_workspace" };
    }
    try {
      const matches = await fg(pattern, { cwd: ctx.cwd, dot: false, onlyFiles: true });
      const entries: string[] = [];
      for (const match of matches) {
        try {
          resolveSafePath(ctx.cwd, match);
          entries.push(match);
        } catch {
          return { tool: "glob", ok: false, error: "path_outside_workspace" };
        }
      }
      return { tool: "glob", ok: true, entries };
    } catch (err) {
      return { tool: "glob", ok: false, error: (err as Error).message };
    }
  }
};

export const opencodeToolAlias = (runner: ToolRunner): ToolRunner[] => {
  if (runner.name === "read_file") {
    return [
      runner,
      {
        name: "read",
        run: runner.run,
      }
    ];
  }
  if (runner.name === "write_file") {
    return [
      runner,
      {
        name: "write",
        run: runner.run,
      }
    ];
  }
  if (runner.name === "list_dir") {
    return [
      runner,
      {
        name: "list",
        run: runner.run,
      }
    ];
  }
  if (runner.name === "run_shell") {
    return [
      runner,
      {
        name: "run",
        run: runner.run,
      }
    ];
  }
  return [runner];
};

export const withOpenCodeAliases = (runners: ToolRunner[]): ToolRunner[] => {
  const expanded: ToolRunner[] = [];
  for (const runner of runners) {
    expanded.push(...opencodeToolAlias(runner));
  }
  return expanded;
};

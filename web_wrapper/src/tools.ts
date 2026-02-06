import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import fg from "fast-glob";
import crypto from "crypto";

import type { ToolContext, ToolResult, ToolRunner } from "./types.js";
import { DEFAULT_OUTPUT_LIMIT, defaultRedactPatterns, isCommandAllowed, redactSecrets, truncateOutput } from "./safety.js";

type BoundedTextBuffer = {
  limit: number;
  captured: string;
  totalChars: number;
};

const createBoundedTextBuffer = (limit: number): BoundedTextBuffer => ({ limit, captured: "", totalChars: 0 });

const toChunkString = (data: unknown): string => {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(data ?? "");
};

const appendBoundedText = (buffer: BoundedTextBuffer, chunk: unknown) => {
  const text = toChunkString(chunk);
  buffer.totalChars += text.length;
  if (buffer.captured.length >= buffer.limit) return;
  const remaining = buffer.limit - buffer.captured.length;
  buffer.captured += text.length <= remaining ? text : text.slice(0, remaining);
};

const finalizeBoundedText = (buffer: BoundedTextBuffer): { value: string; truncated: boolean } => {
  if (buffer.totalChars <= buffer.limit) {
    return { value: buffer.captured, truncated: false };
  }
  const truncatedChars = buffer.totalChars - buffer.limit;
  return { value: buffer.captured + `\n...[truncated ${truncatedChars} chars]`, truncated: true };
};

const resolveSafePath = (cwd: string, target: string): string => {
  const base = path.resolve(cwd);
  const resolved = path.resolve(base, target);
  const relative = path.relative(base, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error("path_outside_workspace");
};

const isUnsafePathInput = (input: string): boolean => {
  const trimmed = input.trim();
  if (!trimmed) return true;
  if (trimmed.includes("\0")) return true;
  if (trimmed.startsWith("~")) return true;
  if (/(^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed)) return true;
  return false;
};

const isSensitivePath = (relativePath: string): boolean => {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  const patterns = [
    /(^|\/)\.ssh(\/|$)/,
    /(^|\/)\.git(\/|$)/,
    /(^|\/)\.env(\.|$|\/)/,
    /(^|\/)\.npmrc($|\/)/,
    /(^|\/)\.pypirc($|\/)/,
    /(^|\/)\.netrc($|\/)/,
    /(^|\/)id_rsa($|\/)/,
    /(^|\/)id_ed25519($|\/)/,
    /(^|\/)creds?[^\/]*$/i,
    /(^|\/)credentials?[^\/]*$/i,
    /(^|\/)[^\/]*key[^\/]*$/i,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
};

const MAX_WRITE_CHARS = 200000;
const normalizeLineEndings = (value: string): string => value.replace(/\r\n/g, "\n");

const hash8 = (value: string): string => {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
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
      const stdout = createBoundedTextBuffer(DEFAULT_OUTPUT_LIMIT);
      const stderr = createBoundedTextBuffer(DEFAULT_OUTPUT_LIMIT);
      child.stdout.on("data", (data) => appendBoundedText(stdout, data));
      child.stderr.on("data", (data) => appendBoundedText(stderr, data));
      child.on("error", (err) => {
        resolve({
          tool: "run_shell",
          ok: false,
          error: "spawn_failed",
          note: err instanceof Error ? err.message : String(err),
        });
      });
      child.on("close", (code) => {
        const truncOut = finalizeBoundedText(stdout);
        const truncErr = finalizeBoundedText(stderr);
        const patterns = defaultRedactPatterns();
        const redactedOut = redactSecrets(truncOut.value, patterns);
        const redactedErr = redactSecrets(truncErr.value, patterns);
        resolve({
          tool: "run_shell",
          ok: code === 0,
          stdout: redactedOut,
          stderr: redactedErr,
          code,
          truncated:
            truncOut.truncated ||
            truncErr.truncated ||
            redactedOut !== truncOut.value ||
            redactedErr !== truncErr.value,
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
    if (isUnsafePathInput(filePath)) {
      return { tool: "read_file", ok: false, error: "path_outside_workspace" };
    }
    const allowSensitive =
      args.allow_sensitive === true || String(args.allow_sensitive || "").toLowerCase() === "true";
    try {
      const resolved = resolveSafePath(ctx.cwd, filePath);
      const rel = path.relative(ctx.cwd, resolved);
      if (!allowSensitive && isSensitivePath(rel)) {
        return { tool: "read_file", ok: false, error: "sensitive_path" };
      }
      const content = await fs.readFile(resolved, "utf-8");
      const trunc = truncateOutput(content);
      const redacted = redactSecrets(trunc.value, defaultRedactPatterns());
      return {
        tool: "read_file",
        ok: true,
        content: redacted,
        truncated: trunc.truncated || redacted !== trunc.value,
      };
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
    const normalizedContent = normalizeLineEndings(content);
    if (!filePath) {
      return { tool: "write_file", ok: false, error: "missing_path" };
    }
    if (isUnsafePathInput(filePath)) {
      return { tool: "write_file", ok: false, error: "path_outside_workspace" };
    }
    const allowSensitive =
      args.allow_sensitive === true || String(args.allow_sensitive || "").toLowerCase() === "true";
    const allowLarge =
      args.allow_large === true || String(args.allow_large || "").toLowerCase() === "true";
    if (!allowLarge && normalizedContent.length > MAX_WRITE_CHARS) {
      return { tool: "write_file", ok: false, error: "content_too_large", maxChars: MAX_WRITE_CHARS };
    }
    try {
      const resolved = resolveSafePath(ctx.cwd, filePath);
      const rel = path.relative(ctx.cwd, resolved);
      if (!allowSensitive && isSensitivePath(rel)) {
        return { tool: "write_file", ok: false, error: "sensitive_path" };
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, normalizedContent, "utf-8");
      return { tool: "write_file", ok: true };
    } catch (err) {
      return { tool: "write_file", ok: false, error: (err as Error).message };
    }
  }
};

export const editFileTool: ToolRunner = {
  name: "edit_file",
  run: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return { tool: "edit_file", ok: false, error: "unsafe_root" };
    }
    const filePath = String(args.path || args.filePath || args.file_path || "").trim();
    const findText = String(args.find ?? "");
    const replaceText = String(args.replace ?? "");
    const expectedSha = String(args.expected_sha8 ?? args.expected_sha ?? "");
    if (!filePath) {
      return { tool: "edit_file", ok: false, error: "missing_path" };
    }
    if (!findText) {
      return { tool: "edit_file", ok: false, error: "missing_find" };
    }
    if (isUnsafePathInput(filePath)) {
      return { tool: "edit_file", ok: false, error: "path_outside_workspace" };
    }
    const allowSensitive =
      args.allow_sensitive === true || String(args.allow_sensitive || "").toLowerCase() === "true";
    try {
      const resolved = resolveSafePath(ctx.cwd, filePath);
      const rel = path.relative(ctx.cwd, resolved);
      if (!allowSensitive && isSensitivePath(rel)) {
        return { tool: "edit_file", ok: false, error: "sensitive_path" };
      }
      const content = await fs.readFile(resolved, "utf-8");
      const usesCRLF = content.includes("\r\n");
      const normalizedContent = normalizeLineEndings(content);
      if (expectedSha) {
        const currentHash = hash8(normalizedContent);
        if (expectedSha !== currentHash) {
          return { tool: "edit_file", ok: false, error: "expected_sha_mismatch", expected: currentHash };
        }
      }
      const normalizedFind = normalizeLineEndings(findText);
      const normalizedReplace = normalizeLineEndings(replaceText);
      const firstIdx = normalizedContent.indexOf(normalizedFind);
      if (firstIdx === -1) {
        return { tool: "edit_file", ok: false, error: "anchor_not_found" };
      }
      const secondIdx = normalizedContent.indexOf(normalizedFind, firstIdx + normalizedFind.length);
      if (secondIdx !== -1) {
        return { tool: "edit_file", ok: false, error: "anchor_not_unique" };
      }
      const nextContent =
        normalizedContent.slice(0, firstIdx) +
        normalizedReplace +
        normalizedContent.slice(firstIdx + normalizedFind.length);
      const output = usesCRLF ? nextContent.replace(/\n/g, "\r\n") : nextContent;
      await fs.writeFile(resolved, output, "utf-8");
      return { tool: "edit_file", ok: true };
    } catch (err) {
      return { tool: "edit_file", ok: false, error: (err as Error).message };
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
    if (dirPath !== "." && isUnsafePathInput(dirPath)) {
      return { tool: "list_dir", ok: false, error: "path_outside_workspace" };
    }
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

const OPENCODE_ALIASES: Record<string, string> = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  list_dir: "list",
  run_shell: "run",
};

export const opencodeToolAlias = (runner: ToolRunner): ToolRunner[] => {
  const alias = OPENCODE_ALIASES[runner.name];
  if (!alias) return [runner];
  return [
    runner,
    {
      name: alias,
      run: runner.run,
    }
  ];
};

export const withOpenCodeAliases = (runners: ToolRunner[]): ToolRunner[] => {
  const expanded: ToolRunner[] = [];
  for (const runner of runners) {
    expanded.push(...opencodeToolAlias(runner));
  }
  return expanded;
};

import crypto from "crypto";
import type { ProtocolConfig, ToolResult } from "./types.js";

export const DEFAULT_ALLOWLIST = [
  "ls",
  "pwd",
  "whoami",
  "cat",
  "rg",
  "sed",
  "awk",
  "python",
  "python3",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "git",
  "echo",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "printf"
];

export const DEFAULT_DENYLIST = [
  /\brm\s+-rf\b/i,
  /\bmkfs\b/i,
  /\bdd\b/i,
  /\bcurl\b.*\|\s*sh/i,
  /\bwget\b.*\|\s*sh/i,
  /:\(\)\s*\{:\|:&\};:/,
  /\bchmod\b\s+.*\/(etc|bin|usr|lib)\b/i,
  /\bchown\b\s+.*\/(etc|bin|usr|lib)\b/i,
  />\s*\/etc\//i,
  /\bsudo\b/i
];

export const redactSecrets = (input: string, patterns: RegExp[]): string => {
  let output = input;
  for (const pattern of patterns) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
};

export const defaultRedactPatterns = (): RegExp[] => [
  /sk-[a-zA-Z0-9-_]{10,}/g,
  /Bearer\s+[a-zA-Z0-9-._~+/]+=*/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z\-_]{35}/g,
  /GLM_TOKEN=\S+/g,
  /"token"\s*:\s*"[^"]+"/gi
];

export const hashPrompt = (input: string): string => {
  return crypto.createHash("sha256").update(input).digest("hex");
};

export const isCommandAllowed = (command: string, config: ProtocolConfig): { ok: boolean; reason?: string } => {
  const lowered = command.trim().toLowerCase();
  if (!config.allowNetwork) {
    if (/(https?:\/\/|\bssh\b|\bscp\b|\bftp\b)/i.test(command)) {
      return { ok: false, reason: "network_disabled" };
    }
    if (/\bgit\s+clone\b|\bnpm\s+install\b|\bpnpm\s+install\b|\byarn\s+add\b|\bpip\s+install\b/i.test(command)) {
      return { ok: false, reason: "network_disabled" };
    }
  }
  for (const pattern of config.denylistPatterns) {
    if (pattern.test(command)) {
      return { ok: false, reason: "denylist" };
    }
  }
  const first = lowered.split(/\s+/)[0];
  if (!config.allowlistCommands.includes(first)) {
    return { ok: false, reason: "not_allowlisted" };
  }
  return { ok: true };
};

export const truncateOutput = (value: string, limit = 50000): { value: string; truncated: boolean } => {
  if (value.length <= limit) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, limit) + `\n...[truncated ${value.length - limit} chars]`, truncated: true };
};

export const redactToolResult = (result: ToolResult, patterns: RegExp[]): ToolResult => {
  const cloned: ToolResult = { ...result };
  for (const key of Object.keys(cloned)) {
    const val = cloned[key];
    if (typeof val === "string") {
      cloned[key] = redactSecrets(val, patterns);
    }
  }
  return cloned;
};

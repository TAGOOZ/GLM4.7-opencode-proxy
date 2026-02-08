import { DANGEROUS_COMMAND_PATTERNS } from "../../constants.js";

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
  const trimmed = command.trim();
  if (/^\s*(rm|rmdir|del)\b/i.test(trimmed)) {
    // Lightweight cleanup commands should not always require confirmation.
    // Escalate only when force/recursive flags or high-risk targets are present.
    if (/\s-(?:[^\s]*r|[^\s]*f)\b/i.test(trimmed)) return true;
    if (/\s(?:\/|~\/|\*|[a-z]:\\)/i.test(trimmed)) return true;
  }
  return false;
};

const SHELL_CONTROL_OPERATOR_REGEX = /(?:^|[^\\])(?:\|\||&&|[|;&<>`]|[$][(]|\r?\n)/;
const READ_ONLY_COMMANDS = new Set([
  "rg",
  "ripgrep",
  "grep",
  "cat",
  "ls",
  "pwd",
  "whoami",
  "head",
  "tail",
  "find",
  "fd",
  "tree",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "stat",
  "file",
  "du",
  "df",
  "ps",
  "which",
  "dirname",
  "basename",
  "realpath",
  "printf",
  "echo",
  "nl",
  "awk",
  "sed",
]);
const SHELL_ESCAPE_HELPER_REGEX = /\b(xargs|sh|bash|zsh|fish|pwsh|powershell|cmd|python|node|perl|ruby)\b/i;
const READ_ONLY_MUTATION_FLAG_REGEX = /\bsed\s+-i\b|\bfind\b[\s\S]*\s-delete\b/i;

const isReadOnlySearchCommand = (command: string): boolean => {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const first = trimmed.split(/\s+/)[0]?.toLowerCase() || "";
  if (!READ_ONLY_COMMANDS.has(first)) return false;
  if (SHELL_CONTROL_OPERATOR_REGEX.test(trimmed)) return false;
  if (SHELL_ESCAPE_HELPER_REGEX.test(trimmed)) return false;
  if (READ_ONLY_MUTATION_FLAG_REGEX.test(trimmed)) return false;
  return true;
};

export { isDangerousCommand, isNetworkRestrictedCommand, isReadOnlySearchCommand };

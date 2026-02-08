import type { ProtocolConfig } from "web-wrapper-protocol";
import { DEFAULT_ALLOWLIST, DEFAULT_DENYLIST, isCommandAllowed } from "web-wrapper-protocol";

const PROXY_EXTRA_ALLOWLIST = [
  "find",
  "fd",
  "tree",
  "head",
  "tail",
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
  "nl",
  "tee",
  "npx",
  "pytest",
  "uv",
  "cargo",
  "go",
  "rustc",
  "java",
  "javac",
  "mvn",
  "gradle",
  "dotnet",
  "kubectl",
];

export const isProxyShellCommandAllowed = (
  command: string,
  allowNetwork: boolean,
): { ok: boolean; reason?: string } => {
  const allowlistCommands = [...new Set([...DEFAULT_ALLOWLIST, ...PROXY_EXTRA_ALLOWLIST])];
  // ProtocolConfig carries unrelated fields, but isCommandAllowed only reads:
  // allowNetwork, allowlistCommands, denylistPatterns.
  const config: ProtocolConfig = {
    maxIterations: 0,
    maxActionsPerTurn: 0,
    timeoutMs: 0,
    strictJson: true,
    allowNetwork,
    allowAnyCommand: false,
    redactPatterns: [],
    allowlistCommands,
    denylistPatterns: DEFAULT_DENYLIST,
  };
  return isCommandAllowed(command, config);
};

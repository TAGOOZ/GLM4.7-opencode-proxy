import type { ProtocolConfig } from "web-wrapper-protocol";
import { DEFAULT_ALLOWLIST, DEFAULT_DENYLIST, isCommandAllowed } from "web-wrapper-protocol";

export const isProxyShellCommandAllowed = (
  command: string,
  allowNetwork: boolean,
): { ok: boolean; reason?: string } => {
  // ProtocolConfig carries unrelated fields, but isCommandAllowed only reads:
  // allowNetwork, allowlistCommands, denylistPatterns.
  const config: ProtocolConfig = {
    maxIterations: 0,
    maxActionsPerTurn: 0,
    timeoutMs: 0,
    strictJson: true,
    allowNetwork,
    redactPatterns: [],
    allowlistCommands: DEFAULT_ALLOWLIST,
    denylistPatterns: DEFAULT_DENYLIST,
  };
  return isCommandAllowed(command, config);
};


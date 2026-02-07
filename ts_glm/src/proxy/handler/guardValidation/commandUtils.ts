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
  if (/^\s*rm\b/i.test(command)) return true;
  if (/^\s*rmdir\b/i.test(command)) return true;
  if (/^\s*del\b/i.test(command)) return true;
  return false;
};

export { isDangerousCommand, isNetworkRestrictedCommand };

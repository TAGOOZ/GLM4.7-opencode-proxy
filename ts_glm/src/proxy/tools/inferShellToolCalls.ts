import crypto from "crypto";
import { DANGEROUS_COMMAND_PATTERNS, PROXY_DEBUG } from "../constants.js";
import { findTool, normalizeArgsForTool, type ToolInfo } from "./registry.js";
import {
  extractFilePath,
  extractQuotedText,
  looksLikePath,
  pickArgKey,
  shellEscape,
  stripOuterQuotes,
} from "./inferUtils.js";

const extractCommand = (text: string): string | null => {
  const fence = text.match(/```(?:bash|sh)?\n([\s\S]+?)```/i);
  if (fence && fence[1]) {
    return fence[1].trim();
  }
  const inline = text.match(/`([^`]+)`/);
  if (inline && inline[1]) {
    return inline[1].trim();
  }
  const runMatch = text.match(/(?:^|\n)\s*\b(?:run|execute)\s*[:\-]?\s*(.+)$/im);
  if (runMatch && runMatch[1]) {
    return runMatch[1].trim();
  }
  return null;
};

const isDangerousCommand = (command: string): boolean => {
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
};

const inferGrepCommand = (userText: string): string | null => {
  const lowered = userText.toLowerCase();
  if (!/\b(rg|ripgrep|grep)\b/.test(lowered)) return null;
  const pattern = extractQuotedText(userText);
  if (!pattern) return null;
  const target = extractFilePath(userText);
  const path = target && looksLikePath(target) ? target : ".";
  const safePattern = shellEscape(pattern);
  const safePath = shellEscape(path);
  return /\bgrep\b/.test(lowered) ? `grep -R ${safePattern} ${safePath}` : `rg -n ${safePattern} ${safePath}`;
};

const inferSearchCommand = (userText: string): string | null => {
  const match = userText.match(/\b(?:search for|find)\s+(.+?)\s+in\s+(.+)/i);
  if (!match) return null;
  const pattern = stripOuterQuotes(match[1].trim());
  if (!pattern) return null;
  const target = stripOuterQuotes(match[2].trim()).replace(/[.,:;!?)]$/, "") || ".";
  const safePattern = shellEscape(pattern);
  const safePath = shellEscape(target);
  if (/\b(rg|ripgrep)\b/i.test(userText)) {
    return `rg -n ${safePattern} ${safePath}`;
  }
  return `grep -R -n ${safePattern} ${safePath}`;
};

const inferSearchToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const command = inferSearchCommand(userText) || inferGrepCommand(userText);
  if (!command) return null;
  if (!/^(rg|ripgrep|grep)\b/i.test(command.trim())) return null;
  const toolInfo = findTool(registry, "run") || findTool(registry, "run_shell");
  if (!toolInfo) return null;
  const key = pickArgKey(toolInfo, ["command", "cmd"]);
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "run_shell";
  const args = normalizeArgsForTool(toolInfo, { [key]: command });
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify(args) },
    },
  ];
};

const inferDeleteCommand = (userText: string): string | null => {
  const lowered = userText.toLowerCase();
  if (!/\b(delete|remove)\b/.test(lowered)) return null;
  const target = extractFilePath(userText);
  if (!target || !looksLikePath(target)) return null;
  const isDir = /\b(directory|folder)\b/.test(lowered);
  const safeTarget = shellEscape(target);
  return isDir ? `rm -rf ${safeTarget}` : `rm -f ${safeTarget}`;
};

const inferMkdirCommand = (userText: string): string | null => {
  const mkdirMatch = userText.match(
    /(?:create|make)\s+(?:a\s+)?(?:directory|folder)\s+(?:\"([^\"]+)\"|'([^']+)'|`([^`]+)`|([^\s]+))/i,
  );
  if (!mkdirMatch) return null;
  const raw = (mkdirMatch[1] || mkdirMatch[2] || mkdirMatch[3] || mkdirMatch[4] || "").trim();
  if (!raw) return null;
  const dirName = stripOuterQuotes(raw).replace(/[.,:;!?)]$/, "");
  return `mkdir -p ${shellEscape(dirName)}`;
};

const inferMoveCommand = (userText: string): string | null => {
  const mvMatch = userText.match(
    /(?:rename|move)\s+((?:\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s]+))\s+(?:to|as)\s+((?:\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s]+))/i,
  );
  if (!mvMatch || !mvMatch[1] || !mvMatch[2]) return null;
  const src = stripOuterQuotes(mvMatch[1]).replace(/[.,:;!?)]$/, "");
  const dst = stripOuterQuotes(mvMatch[2]).replace(/[.,:;!?)]$/, "");
  return `mv ${shellEscape(src)} ${shellEscape(dst)}`;
};

const inferRunToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const toolInfo = findTool(registry, "run") || findTool(registry, "run_shell");
  if (!toolInfo) return null;
  const loweredUser = userText.toLowerCase();
  if (
    /\b(create|make)\b/.test(loweredUser) &&
    /\b(file|python file|py file)\b/.test(loweredUser) &&
    /\b(folder|directory|dir)\b/.test(loweredUser)
  ) {
    return null;
  }
  const command = extractCommand(userText);
  let inferred: string | null = null;
  if (command) {
    const loweredCmd = command.toLowerCase().trim();
    if (!/^(rg|ripgrep|grep|rm|mkdir|mv)\b/.test(loweredCmd)) {
      if (!isDangerousCommand(command)) {
        inferred = command;
      } else if (PROXY_DEBUG) {
        console.warn("proxy_debug blocked_dangerous_command");
      }
    }
  }
  if (!inferred) {
    inferred =
      inferSearchCommand(userText) ||
      inferGrepCommand(userText) ||
      inferDeleteCommand(userText) ||
      inferMkdirCommand(userText) ||
      inferMoveCommand(userText);
  }
  if (!inferred) return null;
  const key = pickArgKey(toolInfo, ["command", "cmd"]);
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "run_shell";
  const args = normalizeArgsForTool(toolInfo, { [key]: inferred });
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify(args) },
    },
  ];
};

export { inferRunToolCall, inferSearchToolCall };


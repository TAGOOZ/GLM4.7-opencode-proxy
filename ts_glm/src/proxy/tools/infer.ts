import crypto from "crypto";
import { DANGEROUS_COMMAND_PATTERNS, PROXY_DEBUG } from "../constants.js";
import { findTool, normalizeArgsForTool, type ToolInfo } from "./registry.js";
import { parseRawJson } from "./parse.js";
import { isSensitivePath } from "./pathSafety.js";

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

const looksLikePath = (value: string | null): boolean => {
  if (!value) return false;
  if (value.startsWith("~") || value.startsWith(".") || value.includes("/") || value.includes("\\")) return true;
  if (/\.[A-Za-z0-9]{1,10}$/.test(value)) return true;
  return false;
};

const extractQuotedText = (text: string): string | null => {
  const matches = [...text.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)];
  if (!matches.length) return null;
  const candidates = matches
    .map((match) => (match[1] || match[2] || match[3] || "").trim())
    .filter(Boolean);
  if (!candidates.length) return null;
  const nonPath = candidates.find((value) => !looksLikePath(value));
  return nonPath || candidates[0] || null;
};

const stripOuterQuotes = (value: string): string => {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("`") && value.endsWith("`"))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const extractKeyValueArgs = (raw: string): Record<string, string> | null => {
  const matches = [...raw.matchAll(/([A-Za-z0-9_]+)=("([^"]*)"|'([^']*)'|`([^`]*)`|([^\\s]+))/g)];
  if (!matches.length) return null;
  const args: Record<string, string> = {};
  for (const match of matches) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? match[5] ?? match[6] ?? "";
    args[key] = value;
  }
  return Object.keys(args).length ? args : null;
};

const extractPatchBlock = (text: string): string | null => {
  const fenced = text.match(/```(?:diff|patch)?\n([\s\S]+?)```/i);
  if (fenced && fenced[1]) {
    const block = fenced[1].trim();
    if (/^\s*(\*\*\* Begin Patch|diff --git)/m.test(block)) {
      return block;
    }
  }
  const beginMatch = /\*\*\* Begin Patch/.exec(text);
  const endMatch = /\*\*\* End Patch/.exec(text);
  if (beginMatch && endMatch && endMatch.index > beginMatch.index) {
    return text.slice(beginMatch.index, endMatch.index + "*** End Patch".length).trim();
  }
  return null;
};

const parsePatchForEdit = (patch: string): { filePath: string; oldString: string; newString: string } | null => {
  const fileMatch =
    patch.match(/^\s*\*\*\*\s+Update File:\s*(.+)$/m) ||
    patch.match(/^\s*\+\+\+\s+b\/(.+)$/m) ||
    patch.match(/^\s*diff --git a\/.+ b\/(.+)$/m);
  if (!fileMatch) return null;
  const filePath = fileMatch[1]?.trim();
  if (!filePath) return null;
  const lines = patch.split(/\r?\n/);
  let inHunk = false;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (trimmed.startsWith("*** End Patch")) break;
    if (trimmed.startsWith("---") || trimmed.startsWith("+++")) continue;
    if (trimmed.startsWith("-")) {
      oldLines.push(trimmed.slice(1));
      continue;
    }
    if (trimmed.startsWith("+")) {
      newLines.push(trimmed.slice(1));
      continue;
    }
  }
  if (!oldLines.length || !newLines.length) return null;
  return { filePath, oldString: oldLines.join("\n"), newString: newLines.join("\n") };
};

const extractDirPath = (text: string): string | null => {
  const matches = [...text.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)];
  if (matches.length) {
    let candidate = matches[matches.length - 1].slice(1).find(Boolean) as string | undefined;
    if (candidate) {
      candidate = candidate.replace(/[.,:;!?)]$/, "");
      if (candidate === "/" || candidate === "\\") {
        return null;
      }
      if (!/\.[A-Za-z0-9]{1,10}$/.test(candidate)) {
        return candidate;
      }
    }
  }
  const tokens = text.trim().split(/\s+/).map((t) => t.replace(/[.,:;!?)]$/, ""));
  const token = tokens.find((t) => {
    if (t === "/" || t === "\\") return false;
    const hasPathHint = t.includes("/") || t.includes("\\") || t.startsWith("~") || t.startsWith(".");
    return hasPathHint && !/\.[A-Za-z0-9]{1,10}$/.test(t);
  });
  return token || null;
};

const shellEscape = (value: string): string => {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

const pickArgKey = (toolInfo: ToolInfo | null, candidates: string[]): string => {
  const argKeys = toolInfo?.argKeys || [];
  for (const key of candidates) {
    if (argKeys.includes(key)) return key;
  }
  return candidates[0];
};

const inferExplicitToolCalls = (registry: Map<string, ToolInfo>, userText: string) => {
  const lines = userText.split(/\r?\n/);
  const toolCalls = [];
  for (const line of lines) {
    const match = line.match(/^\s*%\s*([A-Za-z0-9_.:-]+)\s*[:\\-]?\s*(.*)$/);
    if (!match) continue;
    const rawName = match[1];
    const rest = (match[2] || "").trim();
    const toolInfo = findTool(registry, rawName);
    if (!toolInfo) continue;
    let args: Record<string, unknown> = {};
    if (rest) {
      const parsed = parseRawJson(rest);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        const kvArgs = extractKeyValueArgs(rest);
        if (kvArgs) {
          args = kvArgs;
        } else {
          const key = pickArgKey(toolInfo, [
            "url",
            "uri",
            "path",
            "filePath",
            "query",
            "input",
            "text",
            "command",
            "cmd",
            "pattern",
          ]);
          args = { [key]: rest };
        }
      }
    }
    args = normalizeArgsForTool(toolInfo, args);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || rawName;
    toolCalls.push({
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: toolCalls.length,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify(args) },
    });
  }
  return toolCalls.length ? toolCalls : null;
};


const extractFilePath = (text: string): string | null => {
  let normalized = text.trim();
  if (
    (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
    (normalized.startsWith("'") && normalized.endsWith("'")) ||
    (normalized.startsWith("`") && normalized.endsWith("`"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  const fileMatches = [...normalized.matchAll(/([A-Za-z0-9_./-]+\\.[A-Za-z0-9]{1,10})/g)];
  if (fileMatches.length) {
    return fileMatches[fileMatches.length - 1][1];
  }
  const matches = [...normalized.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)];
  if (matches.length) {
    let candidate = matches[matches.length - 1].slice(1).find(Boolean) as string | undefined;
    if (candidate) {
      candidate = candidate.replace(/[.,:;!?)]$/, "");
      const lowered = candidate.toLowerCase();
      if (lowered.startsWith("read ") || lowered.startsWith("open ") || lowered.startsWith("show ") || lowered.startsWith("cat ")) {
        candidate = candidate.replace(/^(read|open|show|cat)\s+/i, "");
      }
      return candidate;
    }
  }
  const tokens = normalized.split(/\s+/).map((t) => t.replace(/[.,:;!?)]$/, ""));
  const token = tokens.find((t) => /\.[A-Za-z0-9]{1,10}$/.test(t));
  if (token) return token;
  const pathToken = tokens.find((t) => /[\\/]/.test(t) || t.startsWith("~") || t.startsWith("."));
  return pathToken || null;
};

const inferReadToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const lowered = userText.toLowerCase();
  const path = extractFilePath(userText);
  const hasSearchIntent = /\b(search|find)\b/.test(lowered);
  const hasReadVerb = /\b(read|open|show|cat|print|display)\b/.test(lowered);
  const hasReadIntent = hasReadVerb || hasSearchIntent;
  const hasRunTool = Boolean(findTool(registry, "run") || findTool(registry, "run_shell"));
  if (!hasReadIntent) return null;
  if (hasSearchIntent && hasRunTool) return null;
  if (/\b(directory|folder|dir)\b/.test(lowered) && path && !/\.[A-Za-z0-9]{1,10}$/.test(path)) {
    return null;
  }
  const toolInfo = findTool(registry, "read");
  if (!toolInfo) return null;
  if (!path) return null;
  if (isSensitivePath(path)) return null;
  const key = pickArgKey(toolInfo, ["filePath", "path"]);
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "read";
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify({ [key]: path }) },
    },
  ];
};

const inferWriteToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const toolInfo = findTool(registry, "write");
  if (!toolInfo) return null;
  const patterns = [
    /create (?:a )?file\s+([\w./-]+)\s+with content\s+([\s\S]+)/i,
    /create (?:a )?file\s+([\w./-]+)\s+with\s+([\s\S]+)/i,
    /write\s+([\s\S]+?)\s+to\s+([\w./-]+)/i,
    /save\s+([\w./-]+)\s+content\s+([\s\S]+)/i,
  ];
  for (const pattern of patterns) {
    const match = userText.match(pattern);
    if (!match) continue;
    let filePath = match[1];
    let content = match[2];
    if (pattern === patterns[2]) {
      filePath = match[2];
      content = match[1];
    }
    filePath = filePath.replace(/^[\"'`]/, "").replace(/[\"'`].*$/, "");
    content = content.replace(/^[\"'`]/, "").replace(/[\"'`]$/, "");
    if (!filePath || !content) continue;
    const pathKey = pickArgKey(toolInfo, ["filePath", "path"]);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "write";
    return [
      {
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        index: 0,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify({ [pathKey]: filePath, content }) },
      },
    ];
  }
  // Fallback: "create file X" without content -> use placeholder
  const simple = userText.match(/create (?:a )?file\s+([\w./-]+)/i);
  if (simple && simple[1]) {
    const filePath = simple[1];
    const pathKey = pickArgKey(toolInfo, ["filePath", "path"]);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "write";
    return [
      {
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        index: 0,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify({ [pathKey]: filePath, content: "" }) },
      },
    ];
  }
  return null;
};

const inferApplyPatchToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const patch = extractPatchBlock(userText);
  if (!patch) return null;
  const toolInfo = findTool(registry, "apply_patch");
  if (!toolInfo) return null;
  const key = pickArgKey(toolInfo, ["patch", "input", "diff", "changes"]);
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "apply_patch";
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify({ [key]: patch }) },
    },
  ];
};

const inferEditToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const patch = extractPatchBlock(userText);
  if (!patch) return null;
  const toolInfo = findTool(registry, "edit") || findTool(registry, "edit_file");
  if (!toolInfo) return null;
  const parsed = parsePatchForEdit(patch);
  if (!parsed) return null;
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "edit";
  const args = {
    filePath: parsed.filePath,
    oldString: parsed.oldString,
    newString: parsed.newString,
  };
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify(normalizeArgsForTool(toolInfo, args)) },
    },
  ];
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
  return /\bgrep\b/.test(lowered)
    ? `grep -R ${safePattern} ${safePath}`
    : `rg -n ${safePattern} ${safePath}`;
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
    /(?:create|make)\s+(?:a\s+)?(?:directory|folder)\s+(?:\"([^\"]+)\"|'([^']+)'|`([^`]+)`|([^\s]+))/i
  );
  if (!mkdirMatch) return null;
  const raw = (mkdirMatch[1] || mkdirMatch[2] || mkdirMatch[3] || mkdirMatch[4] || "").trim();
  if (!raw) return null;
  const dirName = stripOuterQuotes(raw).replace(/[.,:;!?)]$/, "");
  return `mkdir -p ${shellEscape(dirName)}`;
};

const inferMoveCommand = (userText: string): string | null => {
  const mvMatch = userText.match(
    /(?:rename|move)\s+((?:\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s]+))\s+(?:to|as)\s+((?:\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s]+))/i
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

const inferListToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const lowered = userText.toLowerCase();
  const listIntent = ["list files", "list folders", "list directory", "show files", "inspect files"];
  const dirIntent = [
    "directory contents",
    "folder contents",
    "contents of",
    "what is in",
    "what's in",
    "read directory",
    "read dir",
    "show directory",
    "show folder",
  ];
  const hasLsToken = /\bls\b/.test(lowered);
  if (!hasLsToken && !listIntent.some((k) => lowered.includes(k)) && !dirIntent.some((k) => lowered.includes(k))) {
    return null;
  }
  const toolInfo = findTool(registry, "glob") || findTool(registry, "list");
  if (!toolInfo) return null;
  const key = pickArgKey(toolInfo, ["pattern", "path"]);
  const dirPath = extractDirPath(userText) || ".";
  const pattern =
    dirPath === "." || dirPath === "./"
      ? "**/*"
      : `${dirPath.replace(/\/$/, "")}/**/*`;
  const args = key === "pattern" ? { [key]: pattern } : { [key]: dirPath };
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolInfo.tool.function?.name || toolInfo.tool.name || "glob", arguments: JSON.stringify(args) },
    },
  ];
};

export {
  inferExplicitToolCalls,
  inferApplyPatchToolCall,
  inferEditToolCall,
  inferListToolCall,
  inferReadToolCall,
  inferRunToolCall,
  inferWriteToolCall,
  inferSearchToolCall,
};

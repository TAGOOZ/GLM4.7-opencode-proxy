import { SYSTEM_PROMPT } from "web-wrapper-protocol";
import {
  PROXY_TOOL_PROMPT_EXTRA_SYSTEM_MAX_CHARS,
  PROXY_TOOL_PROMPT_INCLUDE_SCHEMA,
  PROXY_TOOL_PROMPT_SCHEMA_MAX_CHARS,
} from "../constants.js";

const truncateText = (text: string, maxChars: number): string => {
  if (!text) return "";
  if (maxChars <= 0) return text;
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n... (${trimmed.length - maxChars} chars truncated) ...`.trim();
};

const extractArgKeys = (parameters: any): string[] => {
  const props = parameters?.properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props);
};

const formatParameters = (parameters: any): string | null => {
  if (!parameters) return null;
  const keys = extractArgKeys(parameters);
  if (!PROXY_TOOL_PROMPT_INCLUDE_SCHEMA) {
    return keys.length ? `  args: ${keys.join(", ")}` : null;
  }
  const raw = JSON.stringify(parameters);
  return `  parameters: ${truncateText(raw, PROXY_TOOL_PROMPT_SCHEMA_MAX_CHARS)}`;
};

const toolPromptCache = new WeakMap<any[], Map<string, string>>();

const buildToolPrompt = (tools: any[], extraSystem?: string): string => {
  const extra =
    extraSystem && extraSystem.trim()
      ? truncateText(extraSystem, PROXY_TOOL_PROMPT_EXTRA_SYSTEM_MAX_CHARS)
      : "";

  let cachedByExtra = toolPromptCache.get(tools);
  if (!cachedByExtra) {
    cachedByExtra = new Map<string, string>();
    toolPromptCache.set(tools, cachedByExtra);
  }
  const cached = cachedByExtra.get(extra);
  if (cached) return cached;

  const lines = [SYSTEM_PROMPT, "", "Allowed tools:"];
  for (const tool of tools) {
    const fn = tool.function || {};
    const name = fn.name || tool.name || "tool";
    lines.push(`- ${name}: ${fn.description || ""}`.trim());
    const paramsLine = formatParameters(fn.parameters);
    if (paramsLine) lines.push(paramsLine);
  }
  if (extra) {
    lines.push("");
    lines.push("Additional system instructions (follow them):");
    lines.push(extra);
  }
  lines.push("");
  lines.push("Execution rules:");
  lines.push("- If tools are needed, include them only in JSON actions (never tool_calls output).");
  lines.push("- Args must be valid JSON and should use declared argument keys.");
  lines.push("- If a tool is required by the request, include an action for it.");
  lines.push("- Prefer read/list/glob/grep before mutation when path is unclear.");
  lines.push("- Use repo-relative paths and explicit targets for file tools.");
  lines.push("- use the tool's declared path key exactly (path/filePath/file_path).");
  lines.push("- never emit read/write/edit/list/listdir actions without an explicit target path.");
  lines.push("- apply_patch/patch must include explicit target files in patch text (*** Update File: ... or diff --git ...).");
  lines.push("- do not emit apply_patch/patch without target file headers in the patch body.");
  lines.push("- avoid absolute paths, ~, and ../ traversal; these trigger path guards.");
  lines.push("- For mutation tools (write/edit/apply_patch/run/delete), emit at most one mutation action per response.");

  const prompt = lines.join("\n");
  if (cachedByExtra.size >= 8) cachedByExtra.clear();
  cachedByExtra.set(extra, prompt);
  return prompt;
};

export { buildToolPrompt };

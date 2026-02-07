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
  const head = Math.max(1, Math.ceil(maxChars * 0.7));
  const tail = Math.max(1, maxChars - head);
  return `${trimmed.slice(0, head)}\n... (${trimmed.length - maxChars} chars truncated) ...\n${trimmed.slice(-tail)}`.trim();
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
  lines.push("If tools are needed, include them ONLY in the JSON actions array (no tool_calls output).");
  lines.push("Args must be valid JSON. Escape quotes and newlines inside strings.");
  lines.push("Do not include chain-of-thought or analysis in responses. If needed, use the optional \"thought\" field.");
  lines.push("If system or user instructions require a tool, you must include an action for it.");
  lines.push("If the user asks to search, browse, fetch, or for latest/trending/news/docs, you must call a tool.");
  lines.push("");
  lines.push("Tool selection guidance:");
  lines.push("- read: open an existing file to inspect contents before changing it.");
  lines.push("- write: create a new file or replace a file only when explicitly asked to overwrite.");
  lines.push("- edit: modify an existing file with targeted changes when possible.");
  lines.push("- when a file change is required, always use write/edit tools instead of pasting code in the final response.");
  lines.push("- for mutation tools (write/edit/apply_patch/run): include ONLY ONE action per response (confirmation boundary).");
  lines.push("- list/glob/grep: discover files or search content before editing.");
  lines.push("- be cautious when editing high-impact files (package.json, workflows, lockfiles).");
  lines.push("- use repo-relative paths (avoid absolute paths).");
  lines.push("- run: avoid mkdir unless the user explicitly asked to create a folder.");
  lines.push("- explicit tool call: use a line starting with \"% tool_name\" to request a tool directly.");
  lines.push("- confirmations are handled by the client (e.g., OpenCode permissions).");
  lines.push("");
  lines.push("Examples (format only):");
  lines.push(
    JSON.stringify({
      plan: ["inspect file"],
      actions: [
        {
          tool: "TOOL_NAME",
          args: { path: "README.md" },
          why: "need the file contents",
          expect: "file text",
          safety: { risk: "low", notes: "" },
        },
      ],
    })
  );
  lines.push(
    JSON.stringify({
      plan: ["answer directly"],
      actions: [],
      final: "Concise response to the user.",
    })
  );

  const prompt = lines.join("\n");
  if (cachedByExtra.size >= 8) cachedByExtra.clear();
  cachedByExtra.set(extra, prompt);
  return prompt;
};

export { buildToolPrompt };

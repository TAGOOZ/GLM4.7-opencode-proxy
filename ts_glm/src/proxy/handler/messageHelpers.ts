import type { getContextConfig } from "../context.js";
import { compactMessages } from "../context.js";
import { convertMessages } from "../messages.js";
import { safeJson, truncate } from "../debug.js";
import { extractContentText } from "./utils.js";

type ContextConfig = ReturnType<typeof getContextConfig>;

type TestDirectives = {
  cleaned: string;
  systemLine: string | null;
  forceToolResult: boolean;
  disableHeuristics: boolean;
};

export const previewMessage = (msg: any) => {
  const role = msg?.role;
  if (role === "tool") {
    const content = typeof msg?.content === "string" ? msg.content : safeJson(msg?.content);
    return {
      role,
      tool_call_id: msg?.tool_call_id,
      content: truncate(content, 400),
    };
  }
  const content = extractContentText(msg?.content);
  return {
    role,
    name: msg?.name,
    content: truncate(content || "", 400),
    tool_calls: Array.isArray(msg?.tool_calls)
      ? msg.tool_calls.map((c: any) => ({
          id: c?.id,
          type: c?.type,
          name: c?.function?.name,
        }))
      : undefined,
  };
};

export const extractTestDirectives = (content: string): TestDirectives => {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let systemLine: string | null = null;
  let forceToolResult = false;
  let disableHeuristics = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("/system")) {
      const value = trimmed.slice("/system".length).trim();
      if (value) systemLine = value;
      continue;
    }
    if (
      trimmed === "/test tool_result" ||
      trimmed === "/test tool-result" ||
      trimmed === "/test tool_loop" ||
      trimmed === "/test tool-loop"
    ) {
      forceToolResult = true;
      continue;
    }
    if (
      trimmed === "/test no-heuristics" ||
      trimmed === "/test no_heuristics" ||
      trimmed === "/test disable-heuristics" ||
      trimmed === "/test disable_heuristics"
    ) {
      disableHeuristics = true;
      continue;
    }
    kept.push(line);
  }
  return { cleaned: kept.join("\n").trim(), systemLine, forceToolResult, disableHeuristics };
};

export const buildMessages = (
  contextConfig: ContextConfig,
  sourceMessages: any[],
  toolList: any[],
  extraSystem?: string,
) => {
  const converted = convertMessages(sourceMessages, toolList, {
    toolMaxLines: contextConfig.toolMaxLines,
    toolMaxChars: contextConfig.toolMaxChars,
    extraSystem,
  });
  return compactMessages(converted, contextConfig);
};

export const buildInstructionMessages = (
  contextConfig: ContextConfig,
  systemContent: string,
  sourceMessages: any[],
  toolList: any[],
  extraSystem?: string,
) => {
  const base = buildMessages(contextConfig, sourceMessages, toolList, extraSystem);
  const combined = compactMessages(
    [
      {
        role: "system",
        content: systemContent,
      },
      ...base.messages,
    ],
    contextConfig,
  );
  return combined;
};

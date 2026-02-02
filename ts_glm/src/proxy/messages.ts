import { GLMClient } from "../glmClient.js";
import { SYSTEM_PROMPT } from "web-wrapper-protocol";

const buildToolPrompt = (tools: any[]): string => {
  const lines = [SYSTEM_PROMPT, "", "Allowed tools:"];
  for (const tool of tools) {
    const fn = tool.function || {};
    const name = fn.name || tool.name || "tool";
    lines.push(`- ${name}: ${fn.description || ""}`.trim());
    if (fn.parameters) {
      lines.push(`  parameters: ${JSON.stringify(fn.parameters)}`);
    }
  }
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
  return lines.join("\n");
};

const extractContentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part === "object") {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
};

const parseUserDirectives = (text: string): { cleanedText: string; overrides: Record<string, boolean> } => {
  const overrides: Record<string, boolean> = {};
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^\/(thinking|think|search|web|web_search|auto_search|auto-search)\s+(on|off)$/i);
    if (!match) {
      kept.push(line);
      continue;
    }
    const key = match[1].toLowerCase();
    const value = match[2].toLowerCase() === "on";
    if (key === "thinking" || key === "think") {
      overrides.enable_thinking = value;
    } else if (key === "search" || key === "web" || key === "web_search") {
      overrides.web_search = value;
    } else if (key === "auto_search" || key === "auto-search") {
      overrides.auto_web_search = value;
    }
  }
  return { cleanedText: kept.join("\n"), overrides };
};

const stripDirectivesFromContent = (
  content: unknown,
): { content: unknown; cleanedText: string; overrides: Record<string, boolean> } => {
  const extracted = extractContentText(content);
  const { cleanedText, overrides } = parseUserDirectives(extracted);
  if (typeof content === "string") {
    return { content: cleanedText, cleanedText, overrides };
  }
  if (Array.isArray(content)) {
    let updated = false;
    const next = content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const text = (part as { text?: unknown }).text;
      if (!updated && typeof text === "string") {
        updated = true;
        return { ...part, text: cleanedText };
      }
      return part;
    });
    return { content: updated ? next : content, cleanedText, overrides };
  }
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") {
      return { content: { ...content, text: cleanedText }, cleanedText, overrides };
    }
  }
  return { content, cleanedText, overrides };
};

const convertMessages = (messages: any[], tools: any[]): { role: string; content: string }[] => {
  const out: { role: string; content: string }[] = [];
  if (tools.length) {
    out.push({ role: "system", content: buildToolPrompt(tools) });
  }
  for (const msg of messages) {
    if (msg.role === "tool") {
      const rawContent = msg.content ?? "";
      const content =
        typeof rawContent === "object" ? JSON.stringify(rawContent) : String(rawContent || "");
      out.push({ role: "user", content: `Tool result (${msg.name || "tool"}):\n${content}` });
      continue;
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      out.push({ role: "assistant", content: JSON.stringify(msg.tool_calls) });
      continue;
    }
    out.push({ role: msg.role, content: extractContentText(msg.content) || "" });
  }
  return out;
};

const collectGlmResponse = async (
  client: GLMClient,
  chatId: string,
  glmMessages: { role: string; content: string }[],
  options?: { enableThinking?: boolean; features?: Record<string, unknown> },
) => {
  let content = "";
  let thinking = "";
  let parentId: string | null = null;
  try {
    parentId = await client.getCurrentMessageId(chatId);
  } catch {
    parentId = null;
  }
  for await (const chunk of client.sendMessage({
    chatId,
    messages: glmMessages,
    includeHistory: false,
    enableThinking: options?.enableThinking ?? false,
    features: options?.features,
    parentMessageId: parentId,
  })) {
    if (chunk.type === "content") {
      content += chunk.data;
    } else if (chunk.type === "thinking") {
      thinking += chunk.data;
    }
  }
  if (thinking) {
    return `<think>\n${thinking.trim()}\n</think>\n\n${content.trim()}`.trim();
  }
  return content.trim();
};

export {
  buildToolPrompt,
  collectGlmResponse,
  convertMessages,
  stripDirectivesFromContent,
};

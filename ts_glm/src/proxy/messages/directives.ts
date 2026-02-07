import { extractContentText } from "./content.js";

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

export { stripDirectivesFromContent };

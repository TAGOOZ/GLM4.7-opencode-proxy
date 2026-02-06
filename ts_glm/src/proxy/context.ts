import {
  CONTEXT_MAX_TOKENS,
  CONTEXT_MIN_RECENT_MESSAGES,
  CONTEXT_RECENT_MESSAGES,
  CONTEXT_RESERVE_TOKENS,
  CONTEXT_SAFETY_MARGIN,
  CONTEXT_SUMMARY_MAX_CHARS,
  CONTEXT_TOOL_MAX_CHARS,
  CONTEXT_TOOL_MAX_LINES,
} from "./constants.js";

type ContextConfig = {
  maxTokens: number;
  reserveTokens: number;
  safetyMargin: number;
  recentMessages: number;
  minRecentMessages: number;
  summaryMaxChars: number;
  toolMaxLines: number;
  toolMaxChars: number;
};

type ContextStats = {
  usedTokens: number;
  budgetTokens: number;
  remainingTokens: number;
  summaryAdded: boolean;
  droppedMessages: number;
};

type GlmMessage = { role: string; content: string };

const getContextConfig = (): ContextConfig => ({
  maxTokens: CONTEXT_MAX_TOKENS,
  reserveTokens: CONTEXT_RESERVE_TOKENS,
  safetyMargin: CONTEXT_SAFETY_MARGIN,
  recentMessages: CONTEXT_RECENT_MESSAGES,
  minRecentMessages: CONTEXT_MIN_RECENT_MESSAGES,
  summaryMaxChars: CONTEXT_SUMMARY_MAX_CHARS,
  toolMaxLines: CONTEXT_TOOL_MAX_LINES,
  toolMaxChars: CONTEXT_TOOL_MAX_CHARS,
});

const looksLikeCode = (text: string): boolean => {
  const codeTokens = (text.match(/[{}()[\];<>]/g) || []).length;
  const newlineCount = (text.match(/\n/g) || []).length;
  if (codeTokens === 0) return false;
  const ratio = codeTokens / Math.max(1, text.length);
  return ratio > 0.02 || (newlineCount > 3 && ratio > 0.01);
};

const estimateTokens = (text: string): number => {
  if (!text) return 0;
  const divisor = looksLikeCode(text) ? 3 : 4;
  return Math.ceil(text.length / divisor);
};

const estimateMessageTokens = (message: GlmMessage): number => {
  return estimateTokens(`${message.role}:\n${message.content}`);
};

const estimateMessagesTokens = (messages: GlmMessage[]): number => {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
};

const truncateToolContent = (content: string, maxLines: number, maxChars: number): string => {
  if (!content) return "";
  let text = content;
  if (maxLines > 0) {
    const lines = text.split(/\r?\n/);
    if (lines.length > maxLines) {
      const head = Math.max(1, Math.ceil(maxLines * 0.6));
      const tail = Math.max(1, maxLines - head);
      const kept = [...lines.slice(0, head)];
      kept.push(`... (${lines.length - maxLines} lines truncated) ...`);
      kept.push(...lines.slice(-tail));
      text = kept.join("\n");
    }
  }
  if (maxChars > 0 && text.length > maxChars) {
    const head = Math.max(1, Math.ceil(maxChars * 0.6));
    const tail = Math.max(1, maxChars - head);
    text = `${text.slice(0, head)}\n... (${text.length - maxChars} chars truncated) ...\n${text.slice(-tail)}`;
  }
  return text;
};

const summarizeMessages = (messages: GlmMessage[], maxChars: number): string => {
  const lines: string[] = ["Context summary (auto, older messages truncated):"];
  let remaining = maxChars;
  for (const msg of messages) {
    if (remaining <= 0) break;
    const raw = msg.content.replace(/\s+/g, " ").trim();
    if (!raw) continue;
    let label = msg.role;
    if (/^Tool result \(/i.test(msg.content)) {
      label = "tool";
    }
    const snippet = raw.slice(0, 180);
    const line = `- ${label}: ${snippet}`;
    if (line.length > remaining) {
      lines.push(line.slice(0, Math.max(0, remaining - 3)) + "...");
      remaining = 0;
      break;
    }
    lines.push(line);
    remaining -= line.length;
  }
  return lines.join("\n");
};

const compactMessages = (messages: GlmMessage[], config: ContextConfig) => {
  const budgetTokens = Math.max(0, config.maxTokens - config.reserveTokens);
  let pinnedCount = 0;
  while (pinnedCount < messages.length && messages[pinnedCount].role === "system") {
    pinnedCount += 1;
  }
  const pinned = messages.slice(0, pinnedCount);
  const rest = messages.slice(pinnedCount);
  let usedTokens = estimateMessagesTokens(messages);
  const budgetThreshold = budgetTokens - config.safetyMargin;

  if (usedTokens <= budgetThreshold) {
    const remainingTokens = Math.max(0, budgetTokens - usedTokens);
    return {
      messages,
      stats: {
        usedTokens,
        budgetTokens,
        remainingTokens,
        summaryAdded: false,
        droppedMessages: 0,
      },
    };
  }

  const recentCount = Math.max(config.minRecentMessages, config.recentMessages);
  let recent = rest.slice(-recentCount);
  const older = rest.slice(0, rest.length - recent.length);

  let working = [...pinned, ...recent];
  usedTokens = estimateMessagesTokens(working);
  let summaryAdded = false;
  let droppedMessages = 0;
  let summaryMessage: GlmMessage | null = null;

  if (older.length && usedTokens > budgetThreshold) {
    const summary = summarizeMessages(older, config.summaryMaxChars);
    summaryMessage = { role: "system", content: summary };
    working = [...pinned, summaryMessage, ...recent];
    usedTokens = estimateMessagesTokens(working);
    summaryAdded = true;
    droppedMessages = older.length;
  }

  while (working.length > 0 && usedTokens > budgetThreshold && recent.length > config.minRecentMessages) {
    recent = recent.slice(1);
    working = summaryAdded && summaryMessage
      ? [...pinned, summaryMessage, ...recent]
      : [...pinned, ...recent];
    usedTokens = estimateMessagesTokens(working);
    droppedMessages += 1;
  }

  const remainingTokens = Math.max(0, budgetTokens - usedTokens);
  const stats: ContextStats = {
    usedTokens,
    budgetTokens,
    remainingTokens,
    summaryAdded,
    droppedMessages,
  };

  return { messages: working, stats };
};

export {
  compactMessages,
  estimateTokens,
  estimateMessagesTokens,
  getContextConfig,
  truncateToolContent,
  type ContextConfig,
  type ContextStats,
  type GlmMessage,
};

import { GLMClient } from "../../glmClient.js";
import { PROXY_DEBUG } from "../constants.js";
import { debugDump } from "../debug.js";

const collectGlmResponse = async (
  client: GLMClient,
  chatId: string,
  glmMessages: { role: string; content: string }[],
  options?: {
    enableThinking?: boolean;
    features?: Record<string, unknown>;
    includeThinking?: boolean;
    includeHistory?: boolean;
    parentMessageId?: string | null;
  },
) => {
  const detailed = await collectGlmResponseDetailed(client, chatId, glmMessages, options);
  if (detailed.thinking && options?.includeThinking !== false) {
    return `<think>\n${detailed.thinking}\n</think>\n\n${detailed.content}`.trim();
  }
  return detailed.content;
};

const collectGlmResponseDetailed = async (
  client: GLMClient,
  chatId: string,
  glmMessages: { role: string; content: string }[],
  options?: {
    enableThinking?: boolean;
    features?: Record<string, unknown>;
    includeHistory?: boolean;
    parentMessageId?: string | null;
  },
): Promise<{ content: string; thinking: string }> => {
  let content = "";
  let thinking = "";
  const includeHistory = options?.includeHistory ?? false;
  let parentId: string | null | undefined = options?.parentMessageId;
  if (PROXY_DEBUG) {
    debugDump("glm_sendMessage_options", {
      chatId,
      includeHistory,
      enableThinking: Boolean(options?.enableThinking),
      parentMessageId: parentId === undefined ? "[auto]" : parentId,
      messageCount: glmMessages.length,
      messagesPreview: glmMessages.slice(0, 6).map((m) => ({
        role: m.role,
        content: m.content.slice(0, 200),
      })),
    });
  }
  // If we're already including chat history in the completion request, GLMClient will fetch it
  // internally and can resolve the current parent ID from that same request. Avoid the redundant
  // preflight getChat() call in that case.
  if (parentId === undefined && !includeHistory) {
    try {
      parentId = await client.getCurrentMessageId(chatId);
    } catch {
      parentId = null;
    }
  }
  if (parentId === undefined) parentId = null;
  for await (const chunk of client.sendMessage({
    chatId,
    messages: glmMessages,
    includeHistory,
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
  return { content: content.trim(), thinking: thinking.trim() };
};

export { collectGlmResponse, collectGlmResponseDetailed };

import type { Message } from "./types.js";

export function historyToMessages(history: Record<string, any>): { messages: Message[]; current_id: string | null } {
  const messagesMap = history.messages || {};
  const currentId = history.currentId;
  if (!currentId || !messagesMap[currentId]) {
    return { messages: [], current_id: null };
  }
  const chain: string[] = [];
  let cursor: string | null = currentId;
  while (cursor && messagesMap[cursor]) {
    chain.push(cursor);
    cursor = messagesMap[cursor].parentId || null;
  }
  const ordered = chain.reverse();
  const messages = ordered.map((id) => ({ role: messagesMap[id].role, content: messagesMap[id].content }));
  return { messages, current_id: currentId };
}


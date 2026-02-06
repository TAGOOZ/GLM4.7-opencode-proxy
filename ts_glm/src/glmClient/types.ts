export type Chat = {
  id: string;
  title: string;
  models?: string[];
};

export type Message = {
  role: string;
  content: string;
};

export type StreamChunk =
  | { type: "thinking"; data: string }
  | { type: "thinking_end"; data: string }
  | { type: "content"; data: string }
  | { type: "done"; data: string }
  | { type: "error"; data: string };

export type SendMessageOptions = {
  chatId: string;
  messages: Message[];
  model?: string;
  stream?: boolean;
  enableThinking?: boolean;
  includeHistory?: boolean;
  parentMessageId?: string | null;
  generationParams?: Record<string, unknown>;
  features?: Record<string, unknown>;
};


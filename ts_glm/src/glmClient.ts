import crypto from "crypto";
import { getSignatureSync } from "./signature.js";

export type Chat = {
  id: string;
  title: string;
  models?: string[];
};

export type StreamChunk =
  | { type: "thinking"; data: string }
  | { type: "thinking_end"; data: string }
  | { type: "content"; data: string }
  | { type: "done"; data: string }
  | { type: "error"; data: string };

export class GLMClient {
  private token: string;
  private baseUrl = "https://chat.z.ai";

  constructor(token: string) {
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "Accept-Language": "en-US",
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
      "sec-ch-ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"',
      Cookie: `token=${this.token}`,
    };
  }

  private decodeUserId(): string {
    try {
      const payload = this.token.split(".")[1] || "";
      const pad = payload.length % 4 === 0 ? "" : "=".repeat(4 - (payload.length % 4));
      const decoded = Buffer.from(payload + pad, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      return parsed.id || "";
    } catch {
      return "";
    }
  }

  async getChat(chatId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/api/v1/chats/${chatId}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`getChat failed: ${res.status}`);
    return res.json();
  }

  async getCurrentMessageId(chatId: string): Promise<string | null> {
    const data = await this.getChat(chatId);
    const chat = (data as any).chat || {};
    const history = chat.history || {};
    return history.currentId || null;
  }

  private historyToMessages(history: Record<string, any>) {
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

  async getUserSettings(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/api/v1/users/user/settings`, { headers: this.headers() });
    if (!res.ok) throw new Error(`settings failed: ${res.status}`);
    return res.json();
  }

  async listChats(page = 1): Promise<Chat[]> {
    const url = new URL(`${this.baseUrl}/api/v1/chats/`);
    url.searchParams.set("page", String(page));
    const res = await fetch(url.toString(), { headers: this.headers() });
    if (!res.ok) throw new Error(`list chats failed: ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.chats || [];
    return list.map((item: any) => ({ id: item.id, title: item.title, models: item.models }));
  }

  async createChat(title = "New Chat", model = "glm-4.7", initialMessage?: string): Promise<Chat> {
    const timestamp = Date.now();
    const messageId = crypto.randomUUID();
    const history: any = { messages: {}, currentId: null };
    if (initialMessage) {
      history.messages[messageId] = {
        id: messageId,
        parentId: null,
        childrenIds: [],
        role: "user",
        content: initialMessage,
        timestamp: Math.floor(timestamp / 1000),
        models: [model],
      };
      history.currentId = messageId;
    }
    const payload = {
      chat: {
        id: "",
        title,
        models: [model],
        params: {},
        history,
        tags: [],
        flags: [],
        features: [
          { type: "mcp", server: "vibe-coding", status: "hidden" },
          { type: "mcp", server: "ppt-maker", status: "hidden" },
          { type: "mcp", server: "image-search", status: "hidden" },
          { type: "mcp", server: "deep-research", status: "hidden" },
          { type: "tool_selector", server: "tool_selector", status: "hidden" },
        ],
        mcp_servers: [],
        enable_thinking: true,
        auto_web_search: false,
        timestamp,
      },
    };
    const res = await fetch(`${this.baseUrl}/api/v1/chats/new`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`create chat failed: ${res.status}`);
    const data = await res.json();
    return { id: data.id, title: data.title, models: data.models };
  }

  private buildCompletionParams(chatId: string, timestamp: number, requestId: string, userId: string) {
    const now = new Date();
    const utcNow = new Date();
    let tzOffsetMin = 0;
    try {
      tzOffsetMin = -now.getTimezoneOffset();
    } catch {
      tzOffsetMin = 0;
    }

    const params: Record<string, string> = {
      timestamp: String(timestamp),
      requestId,
      user_id: userId,
      version: "0.0.1",
      platform: "web",
      token: this.token,
      user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
      language: "en-US",
      languages: "en-US,en",
      timezone: "UTC",
      cookie_enabled: "true",
      screen_width: "1920",
      screen_height: "1080",
      screen_resolution: "1920x1080",
      viewport_height: "927",
      viewport_width: "1047",
      viewport_size: "1047x927",
      color_depth: "24",
      pixel_ratio: "1",
      current_url: `https://chat.z.ai/c/${chatId}`,
      pathname: `/c/${chatId}`,
      search: "",
      hash: "",
      host: "chat.z.ai",
      hostname: "chat.z.ai",
      protocol: "https:",
      referrer: "https://chat.z.ai/",
      title: "Z.ai Chat - Free AI powered by GLM-4.7 & GLM-4.6",
      timezone_offset: String(tzOffsetMin),
      local_time: utcNow.toISOString().replace("Z", ".000Z"),
      utc_time: utcNow.toUTCString(),
      is_mobile: "false",
      is_touch: "false",
      max_touch_points: "0",
      browser_name: "Chrome",
      os_name: "Linux",
    };
    params.signature_timestamp = String(timestamp);
    return params;
  }

  async *sendMessage(options: {
    chatId: string;
    messages: { role: string; content: string }[];
    model?: string;
    stream?: boolean;
    enableThinking?: boolean;
    includeHistory?: boolean;
    parentMessageId?: string | null;
    generationParams?: Record<string, unknown>;
    features?: Record<string, unknown>;
  }): AsyncGenerator<StreamChunk> {
    const debugStream = process.env.GLM_DEBUG_STREAM === "1";
    const prompt = options.messages.length ? options.messages[options.messages.length - 1].content : "";
    const userId = this.decodeUserId();

    const sigData = getSignatureSync(prompt, userId);
    if (!sigData.success) {
      const error = "error" in sigData ? sigData.error : "signature_failed";
      yield { type: "error", data: error || "signature_failed" };
      return;
    }

    const timestamp = sigData.timestamp;
    const requestId = sigData.request_id;
    const signature = sigData.signature;

    let historyMessages: { role: string; content: string }[] = [];
    let resolvedParentId: string | null | undefined = options.parentMessageId;

    if (options.includeHistory !== false) {
      try {
        const chatData = await this.getChat(options.chatId);
        const history = (chatData as any).chat?.history || {};
        const historyData = this.historyToMessages(history);
        historyMessages = historyData.messages;
        if (!resolvedParentId) {
          resolvedParentId = historyData.current_id;
        }
      } catch {
        historyMessages = [];
      }
    }

    const baseFeatures = {
      image_generation: false,
      web_search: false,
      auto_web_search: false,
      preview_mode: true,
      flags: [],
      enable_thinking: options.enableThinking ?? true,
    };
    const featureOverrides = options.features && typeof options.features === "object" ? options.features : {};
    const features = { ...baseFeatures, ...featureOverrides };
    if (typeof options.enableThinking === "boolean") {
      features.enable_thinking = options.enableThinking;
    }

    const payload = {
      stream: options.stream ?? true,
      model: options.model ?? "glm-4.7",
      messages: [...historyMessages, ...options.messages],
      signature_prompt: prompt,
      params: options.generationParams || {},
      extra: {},
      features,
      variables: {
        "{{USER_NAME}}": "CLI User",
        "{{USER_LOCATION}}": "Unknown",
        "{{CURRENT_DATETIME}}": new Date().toISOString().slice(0, 19).replace("T", " "),
        "{{CURRENT_DATE}}": new Date().toISOString().slice(0, 10),
        "{{CURRENT_TIME}}": new Date().toISOString().slice(11, 19),
        "{{CURRENT_WEEKDAY}}": new Date().toLocaleDateString("en-US", { weekday: "long" }),
        "{{CURRENT_TIMEZONE}}": "UTC",
        "{{USER_LANGUAGE}}": "en-US",
      },
      chat_id: options.chatId,
      id: crypto.randomUUID(),
      current_user_message_id: crypto.randomUUID(),
      current_user_message_parent_id: resolvedParentId,
    };

    const params = this.buildCompletionParams(options.chatId, timestamp, requestId, userId);
    const url = new URL(`${this.baseUrl}/api/v2/chat/completions`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const headers = {
      ...this.headers(),
      Accept: "*/*",
      "X-Signature": signature,
      "X-FE-Version": "prod-fe-1.0.207",
    };

    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok || !res.body) {
      yield { type: "error", data: `request_failed:${res.status}` };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inThinking = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (debugStream) {
          const snippet = dataStr.length > 500 ? `${dataStr.slice(0, 500)}…` : dataStr;
          console.error(`[glm_debug] raw: ${snippet}`);
        }
        if (dataStr === "[DONE]") {
          yield { type: "done", data: "" };
          return;
        }
        try {
          const data = JSON.parse(dataStr);
          if (data.choices) {
            for (const choice of data.choices) {
              const delta = choice.delta || {};
              let content = delta.content || "";
              if (!content) continue;
              const parts = content.split(/(<think>|<\/think>)/g).filter(Boolean);
              for (const part of parts) {
                if (part === "<think>") {
                  inThinking = true;
                  continue;
                }
                if (part === "</think>") {
                  if (inThinking) {
                    inThinking = false;
                    yield { type: "thinking_end", data: "" };
                  } else {
                    inThinking = false;
                  }
                  continue;
                }
                yield { type: inThinking ? "thinking" : "content", data: part };
              }
            }
            continue;
          }
          if (data.type === "chat:completion") {
            const delta = data.data || {};
            const content = delta.delta_content || delta.content || delta.edit_content || "";
            const phase = delta.phase;
            if (phase === "thinking") {
              inThinking = true;
            } else if (["answer", "other", "done"].includes(phase)) {
              if (inThinking) {
                inThinking = false;
                yield { type: "thinking_end", data: "" };
              }
              if (phase === "done") {
                yield { type: "done", data: "" };
                continue;
              }
            }
            if (content) {
              const parts = content.split(/(<details[^>]*>|<\/details>)/g).filter(Boolean);
              for (const part of parts) {
                if (part.startsWith("<details")) {
                  inThinking = true;
                  continue;
                }
                if (part === "</details>") {
                  if (inThinking) {
                    inThinking = false;
                    yield { type: "thinking_end", data: "" };
                  }
                  continue;
                }
                yield { type: inThinking ? "thinking" : "content", data: part };
              }
            }
          }
        } catch {
          continue;
        }
      }
    }
  }
}

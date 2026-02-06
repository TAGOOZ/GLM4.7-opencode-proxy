import crypto from "crypto";

import { getSignatureSync } from "../signature.js";
import { getUserIdFromToken } from "../token.js";

import { DEFAULT_BASE_URL, USER_AGENT } from "./constants.js";
import { historyToMessages } from "./history.js";
import { buildCompletionParams } from "./params.js";
import { parseCompletionStream } from "./streamParser.js";
import type { Chat, Message, SendMessageOptions, StreamChunk } from "./types.js";

export type { Chat, StreamChunk } from "./types.js";

export class GLMClient {
  private token: string;
  private baseUrl = DEFAULT_BASE_URL;

  constructor(token: string) {
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "Accept-Language": "en-US",
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
      "sec-ch-ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"',
      Cookie: `token=${this.token}`,
    };
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

  async *sendMessage(options: SendMessageOptions): AsyncGenerator<StreamChunk> {
    const debugStream = process.env.GLM_DEBUG_STREAM === "1";
    const prompt = options.messages.length ? options.messages[options.messages.length - 1].content : "";
    const userId = getUserIdFromToken(this.token);

    const sigData = getSignatureSync(prompt, userId);
    if (!sigData.success) {
      const error = "error" in sigData ? sigData.error : "signature_failed";
      yield { type: "error", data: error || "signature_failed" };
      return;
    }

    const timestamp = sigData.timestamp;
    const requestId = sigData.request_id;
    const signature = sigData.signature;

    let historyMessages: Message[] = [];
    let resolvedParentId: string | null | undefined = options.parentMessageId;

    if (options.includeHistory !== false) {
      try {
        const chatData = await this.getChat(options.chatId);
        const history = (chatData as any).chat?.history || {};
        const historyData = historyToMessages(history);
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

    const now = new Date();
    const isoNow = now.toISOString();
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
        "{{CURRENT_DATETIME}}": isoNow.slice(0, 19).replace("T", " "),
        "{{CURRENT_DATE}}": isoNow.slice(0, 10),
        "{{CURRENT_TIME}}": isoNow.slice(11, 19),
        "{{CURRENT_WEEKDAY}}": now.toLocaleDateString("en-US", { weekday: "long" }),
        "{{CURRENT_TIMEZONE}}": "UTC",
        "{{USER_LANGUAGE}}": "en-US",
      },
      chat_id: options.chatId,
      id: crypto.randomUUID(),
      current_user_message_id: crypto.randomUUID(),
      current_user_message_parent_id: resolvedParentId,
    };

    const params = buildCompletionParams({
      chatId: options.chatId,
      timestamp,
      requestId,
      userId,
      token: this.token,
    });
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

    for await (const chunk of parseCompletionStream(res.body, { debugStream })) {
      yield chunk;
    }
  }
}


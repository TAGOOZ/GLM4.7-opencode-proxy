import crypto from "crypto";
import { getSignatureSync } from "./signature.js";
import { getUserIdFromToken } from "./token.js";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

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
      user_agent: USER_AGENT,
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
      local_time: now.toISOString().replace("Z", ".000Z"),
      utc_time: now.toUTCString(),
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
    let dedupePending = false;
    let dedupeBuffer = "";
    let thinkingBuffer = "";
    let sawThinking = false;
    let currentThinkingSegment = "";
    let lastThinkingSegment = "";
    let skippingThinking = false;
    let skipThinkingIndex = 0;

    const stripThoughtProcess = (text: string, thinking: string) => {
      const stripLeadingNoise = (input: string) => {
        let output = input;
        while (true) {
          const next = output.replace(/^\s*(true">|<\/?details[^>]*>|<\/?think[^>]*>)\s*/i, "");
          if (next === output) break;
          output = next;
        }
        return output;
      };

      const stripQuotedBlock = (input: string) => {
        const cleaned = stripLeadingNoise(input);
        const lines = cleaned.split(/\r?\n/);
        let idx = 0;
        while (idx < lines.length && lines[idx].trim() === "") idx += 1;
        if (idx < lines.length && /^(thinking|thought process)\s*:?\s*$/i.test(lines[idx].trim())) {
          idx += 1;
        }
        const startIdx = idx;
        let consumed = 0;
        while (idx < lines.length) {
          const line = lines[idx];
          if (line.trim() === "") {
            consumed += 1;
            idx += 1;
            if (consumed > 0) break;
            continue;
          }
          if (line.trim().startsWith(">")) {
            idx += 1;
            consumed += 1;
            continue;
          }
          break;
        }
        if (idx > startIdx) {
          return lines.slice(idx).join("\n");
        }
        return cleaned;
      };

      const heading = text.match(/(^|\n)\s*(Thought Process|Thinking)\s*:?[ \t]*\n/i);
      if (heading) {
        const start = heading.index ?? 0;
        const after = start + heading[0].length;
        const rest = text.slice(after);
        const sepMatch = rest.match(/\n\s*\n/);
        if (!sepMatch) {
          return { text: "", pending: true };
        }
        const end = after + rest.indexOf(sepMatch[0]) + sepMatch[0].length;
        const stripped = text.slice(0, start) + text.slice(end);
        return { text: stripQuotedBlock(stripped), pending: false };
      }

      const trimmedThinking = thinking.trim();
      if (trimmedThinking) {
        const trimmedText = text.trimStart();
        const leadingIndex = text.length - trimmedText.length;
        const prefixMatch = trimmedText.match(/^(Thinking|Thought Process)\s*:?\s*>?\s*/i);
        const compareStart = prefixMatch
          ? trimmedText.slice(prefixMatch[0].length)
          : trimmedText;
        if (compareStart.length < trimmedThinking.length && trimmedThinking.startsWith(compareStart)) {
          return { text: "", pending: true };
        }
        if (compareStart.startsWith(trimmedThinking)) {
          const start = prefixMatch ? leadingIndex : text.indexOf(trimmedThinking);
          if (start !== -1) {
            const removeLength = prefixMatch
              ? prefixMatch[0].length + trimmedThinking.length
              : trimmedThinking.length;
            const stripped = text.slice(0, start) + text.slice(start + removeLength);
            return { text: stripQuotedBlock(stripped), pending: false };
          }
        }
      }

      return { text: stripQuotedBlock(text), pending: false };
    };

    const createThinkingParser = () => {
      let pending = "";
      let inThinking = false;

      const emitText = (text: string, out: StreamChunk[]) => {
        if (!text) return;
        out.push({ type: inThinking ? "thinking" : "content", data: text });
      };

      const setThinking = (value: boolean, out: StreamChunk[]) => {
        if (value === inThinking) return;
        if (inThinking && !value) {
          out.push({ type: "thinking_end", data: "" });
        }
        inThinking = value;
      };

      const handleTag = (tag: string, out: StreamChunk[]) => {
        const match = tag.match(/^<\/?\s*([a-zA-Z0-9:-]+)/);
        const name = match?.[1]?.toLowerCase();
        if (name !== "think" && name !== "details") {
          emitText(tag, out);
          return;
        }
        const closing = tag.startsWith("</");
        setThinking(!closing, out);
      };

      return {
        push(text: string) {
          const out: StreamChunk[] = [];
          pending += text;
          while (pending) {
            const lt = pending.indexOf("<");
            if (lt === -1) {
              emitText(pending, out);
              pending = "";
              break;
            }
            if (lt > 0) {
              emitText(pending.slice(0, lt), out);
              pending = pending.slice(lt);
            }
            const gt = pending.indexOf(">", 1);
            if (gt === -1) break;
            const tag = pending.slice(0, gt + 1);
            pending = pending.slice(gt + 1);
            handleTag(tag, out);
          }
          return out;
        },
        setThinking(value: boolean) {
          const out: StreamChunk[] = [];
          setThinking(value, out);
          return out;
        },
        finalize() {
          const out: StreamChunk[] = [];
          if (pending) {
            const looksLikeTag = /^<\/?(details|think)\b/i.test(pending.trim());
            if (!looksLikeTag) {
              emitText(pending, out);
            }
            pending = "";
          }
          if (inThinking) {
            inThinking = false;
            out.push({ type: "thinking_end", data: "" });
          }
          return out;
        },
      };
    };

    const parser = createThinkingParser();

    const sanitizeThinkingText = (text: string) =>
      text
        .replace(/<\/?(details|think)[^>]*>/gi, "")
        .replace(/\btrue\">/gi, "")
        .replace(/^\s+/, "");

    const emitChunks = async function* (chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
      for (const chunk of chunks) {
        if (chunk.type === "thinking") {
          sawThinking = true;
          const cleaned = sanitizeThinkingText(chunk.data);
          if (!cleaned) continue;

          if (!skippingThinking && !currentThinkingSegment && lastThinkingSegment) {
            const trimmed = cleaned.trimStart();
            const prefix = lastThinkingSegment.slice(0, Math.min(trimmed.length, lastThinkingSegment.length));
            if (trimmed && trimmed === prefix && lastThinkingSegment.length > 50) {
              skippingThinking = true;
              skipThinkingIndex = trimmed.length;
              currentThinkingSegment = trimmed;
              continue;
            }
          }

          if (skippingThinking) {
            const expected = lastThinkingSegment.slice(skipThinkingIndex, skipThinkingIndex + cleaned.length);
            if (expected && cleaned === expected) {
              skipThinkingIndex += cleaned.length;
              currentThinkingSegment += cleaned;
              continue;
            }
            skippingThinking = false;
          }

          thinkingBuffer += cleaned;
          currentThinkingSegment += cleaned;
          yield { type: "thinking", data: cleaned };
          continue;
        }
        if (chunk.type === "thinking_end") {
          if (thinkingBuffer.trim()) {
            dedupePending = true;
          }
          if (currentThinkingSegment.trim()) {
            lastThinkingSegment = currentThinkingSegment;
          }
          currentThinkingSegment = "";
          skippingThinking = false;
          skipThinkingIndex = 0;
          yield chunk;
          continue;
        }
        if (chunk.type !== "content") {
          yield chunk;
          continue;
        }

        if (!dedupePending && sawThinking) {
          dedupePending = true;
        }

        if (!dedupePending) {
          if (chunk.data) yield chunk;
          continue;
        }

        dedupeBuffer += chunk.data;
        const { text, pending } = stripThoughtProcess(dedupeBuffer, thinkingBuffer);
        if (pending && dedupeBuffer.length < 4000) {
          continue;
        }
        dedupePending = false;
        thinkingBuffer = "";
        dedupeBuffer = "";
        if (text) {
          yield { type: "content", data: text };
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Avoid regex splitting, which allocates a large array for long streams.
      let start = 0;
      while (true) {
        const nl = buffer.indexOf("\n", start);
        if (nl === -1) break;
        let line = buffer.slice(start, nl);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        start = nl + 1;

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
              const content = delta.content || "";
              if (!content) continue;
              for await (const chunk of emitChunks(parser.push(content))) {
                yield chunk;
              }
            }
            continue;
          }
          if (data.type === "chat:completion") {
            const delta = data.data || {};
            const content = delta.delta_content || delta.content || delta.edit_content || "";
            const phase = delta.phase;
            if (phase === "thinking") {
              for await (const chunk of emitChunks(parser.setThinking(true))) {
                yield chunk;
              }
            } else if (["answer", "other", "done"].includes(phase)) {
              for await (const chunk of emitChunks(parser.setThinking(false))) {
                yield chunk;
              }
              if (phase === "done") {
                yield { type: "done", data: "" };
                continue;
              }
            }
            if (content) {
              for await (const chunk of emitChunks(parser.push(content))) {
                yield chunk;
              }
            }
          }
        } catch {
          continue;
        }
      }

      if (start > 0) buffer = buffer.slice(start);
    }

    for await (const chunk of emitChunks(parser.finalize())) {
      yield chunk;
    }
  }
}

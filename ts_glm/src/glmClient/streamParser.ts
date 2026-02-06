import type { StreamChunk } from "./types.js";

export async function* parseCompletionStream(
  body: ReadableStream<Uint8Array>,
  options: { debugStream: boolean },
): AsyncGenerator<StreamChunk> {
  const debugStream = options.debugStream;

  const reader = body.getReader();
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
      const compareStart = prefixMatch ? trimmedText.slice(prefixMatch[0].length) : trimmedText;
      if (compareStart.length < trimmedThinking.length && trimmedThinking.startsWith(compareStart)) {
        return { text: "", pending: true };
      }
      if (compareStart.startsWith(trimmedThinking)) {
        const start = prefixMatch ? leadingIndex : text.indexOf(trimmedThinking);
        if (start !== -1) {
          const removeLength = prefixMatch ? prefixMatch[0].length + trimmedThinking.length : trimmedThinking.length;
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


import type { StreamChunk } from "../types.js";
import { sanitizeThinkingText } from "./thinkingParser.js";
import { stripThoughtProcess } from "./thoughtStrip.js";

const createChunkEmitter = () => {
  let dedupePending = false;
  let dedupeBuffer = "";
  let thinkingBuffer = "";
  let sawThinking = false;
  let currentThinkingSegment = "";
  let lastThinkingSegment = "";
  let skippingThinking = false;
  let skipThinkingIndex = 0;

  function* emit(chunks: StreamChunk[]): Generator<StreamChunk> {
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
  }

  return { emit };
};

export { createChunkEmitter };

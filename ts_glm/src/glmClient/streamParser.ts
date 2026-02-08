import type { StreamChunk } from "./types.js";
import { createThinkingParser } from "./streamParser/thinkingParser.js";
import { createChunkEmitter } from "./streamParser/chunkEmitter.js";
import { parseSseLines } from "./streamParser/sse.js";

export async function* parseCompletionStream(
  body: ReadableStream<Uint8Array>,
  options: { debugStream: boolean },
): AsyncGenerator<StreamChunk> {
  const debugStream = options.debugStream;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parser = createThinkingParser();
  const emitter = createChunkEmitter();

  const contentPartToText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const part = value as Record<string, unknown>;
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
    return "";
  };

  const deltaContentToText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((item) => contentPartToText(item)).join("");
    return contentPartToText(value);
  };

  const handleData = (dataStr: string): { chunks: StreamChunk[]; done: boolean } => {
    if (dataStr === "[DONE]") {
      return { chunks: [], done: true };
    }
    try {
      const data = JSON.parse(dataStr);
      const out: StreamChunk[] = [];
      if (data.choices) {
        for (const choice of data.choices) {
          const delta = choice.delta || {};
          const content = deltaContentToText(delta.content);
          if (!content) continue;
          out.push(...parser.push(content));
        }
        return { chunks: out, done: false };
      }
      if (data.type === "chat:completion") {
        const delta = data.data || {};
        const content = deltaContentToText(delta.delta_content ?? delta.content ?? delta.edit_content);
        const phase = delta.phase;
        let done = false;
        let allowContent = true;
        if (phase === "thinking") {
          out.push(...parser.setThinking(true));
        } else if (["answer", "other", "done"].includes(phase)) {
          out.push(...parser.setThinking(false));
          if (phase === "done") {
            done = true;
            allowContent = false;
          }
        }
        if (content && allowContent) {
          out.push(...parser.push(content));
        }
        return { chunks: out, done };
      }
    } catch (error) {
      if (debugStream) {
        const reason = error instanceof Error ? error.message : String(error);
        const snippet = dataStr.length > 500 ? `${dataStr.slice(0, 500)}...` : dataStr;
        console.error(`[glm_debug] stream_json_parse_error: ${reason}; data: ${snippet}`);
      }
      return { chunks: [], done: false };
    }
    return { chunks: [], done: false };
  };

  const processDataLines = (dataLines: string[]): { chunks: StreamChunk[]; done: boolean } => {
    const emitted: StreamChunk[] = [];
    for (const dataStr of dataLines) {
      const result = handleData(dataStr);
      if (result.done) {
        return { chunks: emitted, done: true };
      }
      if (result.chunks) {
        emitted.push(...emitter.emit(result.chunks));
      }
    }
    return { chunks: emitted, done: false };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parsed = parseSseLines(buffer, debugStream);
    buffer = parsed.rest;

    const result = processDataLines(parsed.dataLines);
    for (const chunk of result.chunks) {
      yield chunk;
    }
    if (result.done) {
      yield { type: "done", data: "" };
      return;
    }
  }

  buffer += decoder.decode();
  const flushed = parseSseLines(buffer, debugStream, { flush: true });
  const flushedResult = processDataLines(flushed.dataLines);
  for (const chunk of flushedResult.chunks) {
    yield chunk;
  }
  if (flushedResult.done) {
    yield { type: "done", data: "" };
    return;
  }

  for (const chunk of emitter.emit(parser.finalize())) {
    yield chunk;
  }
}

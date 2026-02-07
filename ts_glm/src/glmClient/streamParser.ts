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
          const content = delta.content || "";
          if (!content) continue;
          out.push(...parser.push(content));
        }
        return { chunks: out, done: false };
      }
      if (data.type === "chat:completion") {
        const delta = data.data || {};
        const content = delta.delta_content || delta.content || delta.edit_content || "";
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
    } catch {
      return { chunks: [], done: false };
    }
    return { chunks: [], done: false };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parsed = parseSseLines(buffer, debugStream);
    buffer = parsed.rest;

    for (const dataStr of parsed.dataLines) {
      const result = handleData(dataStr);
      if (result.done) {
        yield { type: "done", data: "" };
        return;
      }
      if (result.chunks) {
        for (const chunk of emitter.emit(result.chunks)) {
          yield chunk;
        }
      }
      if (result.done) {
        yield { type: "done", data: "" };
        return;
      }
    }
  }

  buffer += decoder.decode();
  const flushed = parseSseLines(buffer, debugStream, { flush: true });
  for (const dataStr of flushed.dataLines) {
    const result = handleData(dataStr);
    if (result.done) {
      yield { type: "done", data: "" };
      return;
    }
    if (result.chunks) {
      for (const chunk of emitter.emit(result.chunks)) {
        yield chunk;
      }
    }
    if (result.done) {
      yield { type: "done", data: "" };
      return;
    }
  }

  for (const chunk of emitter.emit(parser.finalize())) {
    yield chunk;
  }
}

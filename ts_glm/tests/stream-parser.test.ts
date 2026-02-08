import test from "node:test";
import assert from "node:assert/strict";

import { GLMClient } from "../src/glmClient.js";

test("GLMClient stream parser handles chunked SSE lines without split allocations", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const parts = [
        // Split JSON across chunks and mix CRLF/LF to ensure buffering and CR stripping works.
        "data: {\"choices\":[{\"delta\":{\"content\":\"hel",
        "lo\"}}]}\r\n\r\n",
        "data: [DONE]\n\n",
      ];

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(encoder.encode(part));
          controller.close();
        },
      });

      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const client = new GLMClient("test-token");
    const out: string[] = [];
    for await (const chunk of client.sendMessage({
      chatId: "chat_test",
      messages: [{ role: "user", content: "hi" }],
      includeHistory: false,
      stream: true,
      enableThinking: false,
    })) {
      if (chunk.type === "content") out.push(chunk.data);
      if (chunk.type === "done") break;
    }

    assert.deepEqual(out, ["hello"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GLMClient stream parser joins multiline SSE data blocks into one JSON payload", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const parts = [
        "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]\n",
        "data: }\n\n",
        "data: [DONE]\n\n",
      ];

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(encoder.encode(part));
          controller.close();
        },
      });

      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const client = new GLMClient("test-token");
    const out: string[] = [];
    for await (const chunk of client.sendMessage({
      chatId: "chat_test",
      messages: [{ role: "user", content: "hi" }],
      includeHistory: false,
      stream: true,
      enableThinking: false,
    })) {
      if (chunk.type === "content") out.push(chunk.data);
      if (chunk.type === "done") break;
    }

    assert.deepEqual(out, ["hel"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GLMClient stream parser ignores non-text object deltas and does not emit [object Object]", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const parts = [
        "data: {\"choices\":[{\"delta\":{\"content\":{\"foo\":\"bar\"}}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
        "data: [DONE]\n\n",
      ];

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(encoder.encode(part));
          controller.close();
        },
      });

      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const client = new GLMClient("test-token");
    const out: string[] = [];
    for await (const chunk of client.sendMessage({
      chatId: "chat_test",
      messages: [{ role: "user", content: "hi" }],
      includeHistory: false,
      stream: true,
      enableThinking: false,
    })) {
      if (chunk.type === "content") out.push(chunk.data);
      if (chunk.type === "done") break;
    }

    assert.deepEqual(out, ["ok"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import test from "node:test";
import assert from "node:assert/strict";

import { createChatCompletionHandler } from "../src/proxy/handler.js";

test("planner prompt includes runtime workspace context for tool-enabled turns", async () => {
  const captured: any[] = [];
  const client = {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage(payload: any) {
      captured.push(payload);
      yield {
        type: "content",
        data: JSON.stringify({
          plan: ["answer directly"],
          actions: [],
          final: "ok",
        }),
      };
    },
  } as any;

  const handler = createChatCompletionHandler({
    client,
    ensureChat: async () => "chat_runtime_context",
    resetChat: () => {},
  });

  const sent: { payload?: any } = {};
  const reply = {
    header() {
      // ignore
    },
    send(payload: any) {
      sent.payload = payload;
      return payload;
    },
    raw: {
      writeHead() {
        // ignore
      },
      write() {
        // ignore
      },
      end() {
        // ignore
      },
    },
  } as any;

  const request = {
    body: {
      model: "glm-4.7",
      stream: false,
      tools: [
        {
          function: {
            name: "read",
            parameters: { properties: { path: { type: "string" } } },
          },
        },
      ],
      messages: [{ role: "user", content: "help with this task" }],
    },
  } as any;

  await handler(request, reply);
  assert.ok(sent.payload);
  assert.ok(captured.length >= 1);
  const firstCall = captured[0] || {};
  const modelMessages = Array.isArray(firstCall.messages) ? firstCall.messages : [];
  const systemPrompt = String(modelMessages.find((m: any) => m?.role === "system")?.content || "");
  assert.equal(systemPrompt.includes("Runtime workspace context:"), true);
  assert.equal(systemPrompt.includes(`- cwd: ${process.cwd()}`), true);
});

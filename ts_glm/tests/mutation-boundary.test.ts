import test from "node:test";
import assert from "node:assert/strict";

import { createChatCompletionHandler } from "../src/proxy/handler.js";

const makeClient = (content: string) => {
  return {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage() {
      yield { type: "content", data: content };
    },
  } as any;
};

const makeReply = () => {
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
  return { reply, sent };
};

const TOOLS = [
  {
    function: {
      name: "read",
      parameters: { properties: { path: { type: "string" } } },
    },
  },
  {
    function: {
      name: "list",
      parameters: { properties: { path: { type: "string" } } },
    },
  },
  {
    function: {
      name: "write",
      parameters: { properties: { path: { type: "string" }, content: { type: "string" } } },
    },
  },
] as any[];

const runProxy = async (glmResponseText: string) => {
  const handler = createChatCompletionHandler({
    client: makeClient(glmResponseText),
    ensureChat: async () => "chat_1",
    resetChat: () => {},
  });
  const { reply, sent } = makeReply();
  const request = {
    body: {
      model: "glm-4.7",
      stream: false,
      tools: TOOLS,
      messages: [{ role: "user", content: "do the thing" }],
    },
  } as any;
  await handler(request, reply);
  return sent.payload;
};

test("planner multi-action keeps non-mutating prep action before first mutation", async () => {
  const payload = await runProxy(
    JSON.stringify({
      plan: ["inspect then write"],
      actions: [
        { tool: "read", args: { path: "README.md" } },
        { tool: "write", args: { path: "notes.txt", content: "hi" } },
      ],
    }),
  );
  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0]?.function?.name, "read");
  assert.equal(toolCalls[1]?.function?.name, "write");
});

test("planner multi-action without mutation remains unchanged", async () => {
  const payload = await runProxy(
    JSON.stringify({
      plan: ["inspect"],
      actions: [
        { tool: "read", args: { path: "README.md" } },
        { tool: "list", args: { path: "." } },
      ],
    }),
  );
  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 2);
});

test("planner mutate-then-verify keeps first verification step", async () => {
  const payload = await runProxy(
    JSON.stringify({
      plan: ["write then verify"],
      actions: [
        { tool: "write", args: { path: "notes.txt", content: "hi" } },
        { tool: "read", args: { path: "notes.txt" } },
      ],
    }),
  );
  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0]?.function?.name, "write");
  assert.equal(toolCalls[1]?.function?.name, "read");
});

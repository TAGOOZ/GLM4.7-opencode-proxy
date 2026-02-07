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

test("raw tool_calls array exceeding PROXY_MAX_ACTIONS_PER_TURN is truncated", async () => {
  const payload = await runProxy(
    JSON.stringify([
      { name: "read", arguments: { path: "README.md" } },
      { name: "read", arguments: { path: "package.json" } },
      { name: "read", arguments: { path: "AGENTS.md" } },
      { name: "read", arguments: { path: "ts_glm/package.json" } },
    ]),
  );

  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 3);
  assert.equal(toolCalls[0]?.function?.name, "read");
});

test("raw tool_calls array within limit is allowed", async () => {
  const payload = await runProxy(
    JSON.stringify([
      { name: "read", arguments: { path: "README.md" } },
      { name: "read", arguments: { path: "package.json" } },
      { name: "read", arguments: { path: "AGENTS.md" } },
    ]),
  );

  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 3);
  assert.equal(toolCalls[0]?.function?.name, "read");
});

test("planner actions exceeding PROXY_MAX_ACTIONS_PER_TURN are truncated", async () => {
  const payload = await runProxy(
    JSON.stringify({
      plan: ["read a few files"],
      actions: [
        { tool: "read", args: { path: "README.md" } },
        { tool: "read", args: { path: "package.json" } },
        { tool: "read", args: { path: "AGENTS.md" } },
        { tool: "read", args: { path: "examples/sample.md" } },
      ],
    }),
  );

  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 3);
  assert.equal(toolCalls[0]?.function?.name, "read");
});

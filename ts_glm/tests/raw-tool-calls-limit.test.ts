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

test("raw tool_calls array exceeding PROXY_MAX_ACTIONS_PER_TURN is blocked", async () => {
  const payload = await runProxy(
    JSON.stringify([
      { name: "read", arguments: { path: "README.md" } },
      { name: "read", arguments: { path: "README.md" } },
      { name: "read", arguments: { path: "README.md" } },
      { name: "read", arguments: { path: "README.md" } },
    ]),
  );

  const msg = payload?.choices?.[0]?.message;
  assert.equal(typeof msg?.content, "string");
  assert.ok(String(msg.content).includes("Blocked unsafe tool call"));
  assert.ok(String(msg.content).includes("too_many_actions"));
  assert.equal("tool_calls" in msg, false);
});

test("raw tool_calls array within limit is allowed", async () => {
  const payload = await runProxy(
    JSON.stringify([
      { name: "read", arguments: { path: "README.md" } },
      { name: "read", arguments: { path: "README.md" } },
      { name: "read", arguments: { path: "README.md" } },
    ]),
  );

  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 3);
  assert.equal(toolCalls[0]?.function?.name, "read");
});


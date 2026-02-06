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
      name: "write",
      parameters: { properties: { path: { type: "string" }, content: { type: "string" } } },
    },
  },
] as any[];

const runProxy = async (glmResponseText: string, messages: any[]) => {
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
      messages,
    },
  } as any;
  await handler(request, reply);
  return sent.payload;
};

test("planner read without path is repaired from recent conversation", async () => {
  const payload = await runProxy(
    JSON.stringify({
      plan: ["read the file"],
      actions: [{ tool: "read", args: {} }],
    }),
    [
      { role: "assistant", content: "Created calculator in calculator/calculator.py and README.md." },
      { role: "user", content: "open it" },
    ],
  );
  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 1);
  const args = JSON.parse(toolCalls[0]?.function?.arguments || "{}");
  assert.equal(args.path, "calculator/calculator.py");
});

test("planner write without path is blocked (no heuristic mutations)", async () => {
  const payload = await runProxy(
    JSON.stringify({
      plan: ["write a quick note"],
      actions: [{ tool: "write", args: { content: "hi" } }],
    }),
    [
      { role: "assistant", content: "Created calculator in calculator/calculator.py and README.md." },
      { role: "user", content: "please update it" },
    ],
  );

  assert.equal(payload?.choices?.[0]?.message?.tool_calls, undefined);
  assert.equal(payload?.choices?.[0]?.message?.content, "Blocked unsafe tool call (missing_path).");
});


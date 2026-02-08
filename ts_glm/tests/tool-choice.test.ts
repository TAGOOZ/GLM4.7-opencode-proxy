import test from "node:test";
import assert from "node:assert/strict";

import { createChatCompletionHandler } from "../src/proxy/handler.js";

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

const tools = [
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

test("tool_choice function enforces selected tool name", async () => {
  const client: any = {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage() {
      yield {
        type: "content",
        data: JSON.stringify({
          plan: ["write a file"],
          actions: [{ tool: "write", args: { path: "README.md", content: "x" } }],
          final: "",
        }),
      };
    },
  };

  const handler = createChatCompletionHandler({
    client,
    ensureChat: async () => "chat_tool_choice_1",
    resetChat: () => {},
  });
  const { reply, sent } = makeReply();
  await handler(
    {
      body: {
        model: "glm-4.7",
        stream: false,
        tools,
        tool_choice: { type: "function", function: { name: "read" } },
        messages: [{ role: "user", content: "do it" }],
      },
    } as any,
    reply,
  );

  const toolCalls = sent.payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls[0]?.function?.name, "question");
});

test("tool_choice with unknown function returns clear error", async () => {
  const client: any = {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage() {
      yield {
        type: "content",
        data: JSON.stringify({
          plan: ["read a file"],
          actions: [{ tool: "read", args: { path: "README.md" } }],
          final: "",
        }),
      };
    },
  };

  const handler = createChatCompletionHandler({
    client,
    ensureChat: async () => "chat_tool_choice_2",
    resetChat: () => {},
  });
  const { reply, sent } = makeReply();
  await handler(
    {
      body: {
        model: "glm-4.7",
        stream: false,
        tools,
        tool_choice: { type: "function", function: { name: "missing_tool" } },
        messages: [{ role: "user", content: "do it" }],
      },
    } as any,
    reply,
  );

  const content = String(sent.payload?.choices?.[0]?.message?.content || "");
  assert.equal(content.includes("Unknown tool in tool_choice: missing_tool"), true);
});

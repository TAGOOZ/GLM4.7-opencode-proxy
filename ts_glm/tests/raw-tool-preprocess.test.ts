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

const runProxy = async (glmResponseText: string, userMessage: string, tools: any[]) => {
  const handler = createChatCompletionHandler({
    client: makeClient(glmResponseText),
    ensureChat: async () => "chat_raw_preprocess",
    resetChat: () => {},
  });
  const { reply, sent } = makeReply();
  const request = {
    body: {
      model: "glm-4.7",
      stream: false,
      tools,
      messages: [{ role: "user", content: userMessage }],
    },
  } as any;
  await handler(request, reply);
  return sent.payload;
};

test("raw mode drops todowrite when user did not request todos", async () => {
  const tools = [
    { function: { name: "todowrite", parameters: { properties: { todos: { type: "array" } } } } },
    { function: { name: "read", parameters: { properties: { filePath: { type: "string" } } } } },
  ] as any[];

  const payload = await runProxy(
    JSON.stringify([
      { name: "todowrite", arguments: { todos: [{ content: "draft tasks" }] } },
      { name: "read", arguments: { filePath: "snake_game/Cargo.toml" } },
    ]),
    "read cargo file",
    tools,
  );

  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.function?.name, "read");
});

test("raw mode keeps todowrite when user explicitly asks for todo/checklist", async () => {
  const tools = [
    { function: { name: "todowrite", parameters: { properties: { todos: { type: "array" } } } } },
    { function: { name: "read", parameters: { properties: { filePath: { type: "string" } } } } },
  ] as any[];

  const payload = await runProxy(
    JSON.stringify([
      { name: "todowrite", arguments: { todos: [{ content: "draft tasks" }] } },
      { name: "read", arguments: { filePath: "snake_game/Cargo.toml" } },
    ]),
    "make a todo checklist, then read cargo file",
    tools,
  );

  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0]?.function?.name, "todowrite");
  assert.equal(toolCalls[1]?.function?.name, "read");
});

test("raw mode drops no-op edit and keeps actionable calls", async () => {
  const tools = [
    {
      function: {
        name: "edit",
        parameters: {
          properties: {
            filePath: { type: "string" },
            oldString: { type: "string" },
            newString: { type: "string" },
          },
        },
      },
    },
    { function: { name: "read", parameters: { properties: { filePath: { type: "string" } } } } },
  ] as any[];

  const payload = await runProxy(
    JSON.stringify([
      {
        name: "edit",
        arguments: {
          filePath: "snake_game/src/main.rs",
          oldString: "fn main() {}",
          newString: "fn main() {}",
        },
      },
      { name: "read", arguments: { filePath: "snake_game/src/main.rs" } },
    ]),
    "fix the file",
    tools,
  );

  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.function?.name, "read");
});

test("raw mode suppresses duplicate consecutive calls in one batch", async () => {
  const tools = [
    { function: { name: "read", parameters: { properties: { filePath: { type: "string" } } } } },
  ] as any[];

  const payload = await runProxy(
    JSON.stringify([
      { name: "read", arguments: { filePath: "snake_game/Cargo.toml" } },
      { name: "read", arguments: { filePath: "snake_game/Cargo.toml" } },
      { name: "read", arguments: { filePath: "snake_game/src/main.rs" } },
    ]),
    "inspect files",
    tools,
  );

  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0]?.function?.name, "read");
  assert.equal(toolCalls[1]?.function?.name, "read");
});

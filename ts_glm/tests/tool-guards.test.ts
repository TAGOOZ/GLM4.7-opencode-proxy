import test from "node:test";
import assert from "node:assert/strict";
import { buildToolRegistry, findTool, normalizeArgsForTool } from "../src/proxy/tools/registry.js";
import { validateToolCalls } from "../src/proxy/handler/guards.js";
import { createChatCompletionHandler } from "../src/proxy/handler.js";

test("normalizeArgsForTool fills todowrite defaults", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "todowrite",
        parameters: { properties: { todos: { type: "array" } } },
      },
    },
  ]);
  const info = findTool(registry, "todowrite");
  assert.ok(info);
  const normalized = normalizeArgsForTool(info, {
    todos: [{ title: "First task" }, { content: "Second", status: 2 }],
  }) as { todos: Array<Record<string, unknown>> };
  assert.equal(normalized.todos[0].content, "First task");
  assert.equal(normalized.todos[0].status, "todo");
  assert.equal(normalized.todos[0].priority, "medium");
  assert.equal(normalized.todos[1].content, "Second");
  assert.equal(normalized.todos[1].status, "todo");
  assert.equal(normalized.todos[1].priority, "medium");
});

test("dangerous run_shell requests require confirmation when askquestion exists", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "run_shell",
        parameters: { properties: { command: { type: "string" } } },
      },
    },
    {
      function: {
        name: "askquestion",
        parameters: { properties: { question: { type: "string" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_test",
      index: 0,
      type: "function",
      function: {
        name: "run_shell",
        arguments: JSON.stringify({ command: "rm -rf tmp" }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "confirmation_required");
  assert.ok(result.confirmationToolCalls);
  assert.equal(result.confirmationToolCalls?.[0]?.function?.name, "askquestion");
});

test("proxy injects askquestion tool when missing", async () => {
  const captured: any[] = [];
  const client: any = {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage(options: any) {
      captured.push(options.messages);
      const planner = {
        plan: ["confirm"],
        actions: [{ tool: "askquestion", args: { question: "Proceed?" } }],
        final: "",
      };
      yield { type: "content", data: JSON.stringify(planner) };
    },
  };
  const handler = createChatCompletionHandler({
    client,
    ensureChat: async () => "chat_test",
    resetChat: () => {},
  });
  const reply: any = {
    header() {},
    send(payload: any) {
      this.payload = payload;
      return payload;
    },
    raw: { writeHead() {}, write() {}, end() {} },
  };
  const request: any = {
    body: {
      model: "glm-4.7",
      stream: false,
      tools: [
        { function: { name: "read", parameters: { properties: { path: { type: "string" } } } } },
      ],
      messages: [{ role: "user", content: "delete file" }],
    },
  };
  await handler(request, reply);
  const toolCalls = reply.payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls?.[0]?.function?.name, "askquestion");
});

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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
  assert.equal(normalized.todos[0].title, "First task");
  assert.equal(normalized.todos[0].status, "todo");
  assert.equal(normalized.todos[0].priority, "medium");
  assert.equal(typeof normalized.todos[0].id, "string");
  assert.equal(normalized.todos[1].content, "Second");
  assert.equal(normalized.todos[1].title, "Second");
  assert.equal(normalized.todos[1].status, "todo");
  assert.equal(normalized.todos[1].priority, "medium");
  assert.equal(typeof normalized.todos[1].id, "string");
});

test("normalizeArgsForTool drops unsupported shell metadata args", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "bash",
        parameters: { properties: { command: { type: "string" } } },
      },
    },
  ]);
  const info = findTool(registry, "bash");
  assert.ok(info);
  const normalized = normalizeArgsForTool(info, {
    command: "echo ok",
    description: "run shell command: echo ok",
    workdir: "/tmp",
    timeout: 60000,
  }) as Record<string, unknown>;
  assert.equal(normalized.command, "echo ok");
  assert.equal("description" in normalized, false);
  assert.equal("workdir" in normalized, false);
  assert.equal("timeout" in normalized, false);
});

test("bash command-only schema is not blocked by model-added description/workdir args", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "bash",
        parameters: { properties: { command: { type: "string" } } },
      },
    },
  ]);

  const info = findTool(registry, "bash");
  assert.ok(info);
  const args = normalizeArgsForTool(info, {
    command: "echo ok",
    description: "Create folder",
    workdir: process.cwd(),
  });

  const toolCalls = [
    {
      id: "call_bash_meta",
      index: 0,
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify(args),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
  const rewrittenArgs = JSON.parse(String(toolCalls[0].function.arguments));
  assert.equal(rewrittenArgs.command, "echo ok");
  assert.equal("description" in rewrittenArgs, false);
  assert.equal("workdir" in rewrittenArgs, false);
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
  assert.ok(result.pendingConfirmation);
  assert.equal(result.pendingConfirmation?.blockedReason, "dangerous_command");
  assert.equal(result.pendingConfirmation?.toolCalls?.[0]?.function?.name, "run_shell");
});

test("proxy injects question tool when missing", async () => {
  const captured: any[] = [];
  const client: any = {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage(options: any) {
      captured.push(options.messages);
      const planner = {
        plan: ["confirm"],
        actions: [{ tool: "question", args: { question: "Proceed?" } }],
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
  assert.equal(toolCalls?.[0]?.function?.name, "question");
});

test("confirmation uses questions array schema when question tool expects it", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { filePath: { type: "string" } } },
      },
    },
    {
      function: {
        name: "question",
        parameters: { properties: { questions: { type: "array" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_read",
      index: 0,
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ filePath: "/tmp/outside.txt" }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "confirmation_required");
  const confirmationArgs = JSON.parse(String(result.confirmationToolCalls?.[0]?.function?.arguments || "{}"));
  assert.ok(Array.isArray(confirmationArgs.questions));
  assert.equal(typeof confirmationArgs.questions[0]?.question, "string");
});

test("read path inside workspace is normalized from absolute to relative", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { filePath: { type: "string" } } },
      },
    },
  ]);

  const absolutePath = `${process.cwd()}/snake_game/Cargo.toml`;
  const toolCalls = [
    {
      id: "call_read",
      index: 0,
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ filePath: absolutePath }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
  const rewrittenArgs = JSON.parse(String(toolCalls[0].function.arguments));
  assert.equal(typeof rewrittenArgs.filePath, "string");
  assert.equal(String(rewrittenArgs.filePath).includes(".."), false);
  assert.equal(String(rewrittenArgs.filePath).endsWith("snake_game/Cargo.toml"), true);
});

test("bash keeps valid workdir and rewrites to existing canonical path", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "bash",
        parameters: { properties: { command: { type: "string" }, workdir: { type: "string" } } },
      },
    },
  ]);

  const absolutePath = process.cwd();
  const toolCalls = [
    {
      id: "call_bash_workdir",
      index: 0,
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({ command: "echo ok", workdir: absolutePath }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
  const rewrittenArgs = JSON.parse(String(toolCalls[0].function.arguments));
  assert.equal(typeof rewrittenArgs.workdir, "string");
  assert.equal(path.isAbsolute(rewrittenArgs.workdir), true);
  assert.equal(rewrittenArgs.workdir, path.resolve(absolutePath));
});

test("bash invalid workdir is dropped before execution", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "bash",
        parameters: { properties: { command: { type: "string" }, workdir: { type: "string" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_bash_bad_workdir",
      index: 0,
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({
          command: "echo ok",
          workdir: "/media/mustafa-tag-eldeen/563CBB613CBB3B3733/deepseek-glm-api-test",
        }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
  const rewrittenArgs = JSON.parse(String(toolCalls[0].function.arguments));
  assert.equal("workdir" in rewrittenArgs, false);
});

test("write without content is blocked directly (no confirmation replay)", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "write",
        parameters: { properties: { filePath: { type: "string" }, content: { type: "string" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_write",
      index: 0,
      type: "function",
      function: {
        name: "write",
        arguments: JSON.stringify({ filePath: "snake_game/src/main.rs" }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "raw", registry);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_content");
  assert.equal(Array.isArray(result.confirmationToolCalls), false);
});

test("write with invalid JSON arguments is blocked directly (no confirmation replay)", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "write",
        parameters: { properties: { filePath: { type: "string" }, content: { type: "string" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_write_bad",
      index: 0,
      type: "function",
      function: {
        name: "write",
        arguments: "{\"filePath\":\"snake_game/src/main.rs\",\"content\":\"println!(\"oops\")\"}",
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "raw", registry);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_tool_args");
  assert.equal(Array.isArray(result.confirmationToolCalls), false);
});

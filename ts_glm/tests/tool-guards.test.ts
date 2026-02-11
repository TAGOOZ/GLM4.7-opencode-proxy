import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildToolRegistry, findTool, normalizeArgsForTool } from "../src/proxy/tools/registry.js";
import { validatePlannerActions, validateToolCalls } from "../src/proxy/handler/guards.js";
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

test("validateToolCalls repairs invalid backslash escapes in JSON argument strings", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "bash",
        parameters: { properties: { command: { type: "string" } } },
      },
    },
  ]);

  const toolCalls: any[] = [
    {
      id: "call_bash_invalid_escape",
      type: "function",
      function: {
        name: "bash",
        // Invalid JSON due to "\|" escape; should be repaired to "\\|".
        arguments: "{\"command\":\"echo a\\|b\"}",
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
  const rewrittenArgs = JSON.parse(String(toolCalls[0].function.arguments));
  assert.equal(rewrittenArgs.command, "echo a\\|b");
});

test("validateToolCalls recovers common malformed edit arguments with unescaped quotes/newlines", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "edit",
        parameters: { properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } } },
      },
    },
  ]);

  const rawArgs =
    "{\"filePath\":\"src/main.rs\",\"oldString\":\"fn main() {\\n    println!(\"Hello, world!\");\\n}\\n\",\"newString\":\"fn main() {\\n    println!(\"ok\");\\n}\\n\"}";

  const toolCalls: any[] = [
    {
      id: "call_edit_bad_json",
      type: "function",
      function: { name: "edit", arguments: rawArgs },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
  const rewrittenArgs = JSON.parse(String(toolCalls[0].function.arguments));
  assert.equal(rewrittenArgs.filePath, "src/main.rs");
  assert.ok(String(rewrittenArgs.oldString).includes("println!(\"Hello, world!\")"));
  assert.ok(String(rewrittenArgs.newString).includes("println!(\"ok\")"));
});

test("findTool does not fuzzy-match short prefixes", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
    {
      function: {
        name: "remove",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);
  assert.equal(findTool(registry, "re"), null);
});

test("findTool resolves common planner aliases for list/run/read tools", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "list",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
    {
      function: {
        name: "run",
        parameters: { properties: { command: { type: "string" } } },
      },
    },
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);
  assert.equal(findTool(registry, "ls")?.tool.function?.name, "list");
  assert.equal(findTool(registry, "list_allowed_directories")?.tool.function?.name, "list");
  assert.equal(findTool(registry, "exec")?.tool.function?.name, "run");
  assert.equal(findTool(registry, "cat")?.tool.function?.name, "read");
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

test("unexpected args are sanitized instead of blocking valid call", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_read_extra_arg",
      index: 0,
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({
          path: "README.md",
          confidence: 0.9,
          metadata: { source: "model" },
        }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
  const rewrittenArgs = JSON.parse(String(toolCalls[0].function.arguments));
  assert.equal(rewrittenArgs.path, "README.md");
  assert.equal("confidence" in rewrittenArgs, false);
  assert.equal("metadata" in rewrittenArgs, false);
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

test("missing shell command is confirmable when question tool exists", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "run_shell",
        parameters: { properties: { command: { type: "string" } } },
      },
    },
    {
      function: {
        name: "question",
        parameters: { properties: { question: { type: "string" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_test_missing_cmd",
      index: 0,
      type: "function",
      function: {
        name: "run_shell",
        arguments: JSON.stringify({}),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "confirmation_required");
  assert.equal(result.pendingConfirmation?.blockedReason, "missing_command");
});

test("validateToolCalls rewrites write-to-existing-file into edit replacement", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "edit",
        parameters: {
          properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } },
        },
      },
    },
    {
      function: {
        name: "write",
        parameters: { properties: { filePath: { type: "string" }, content: { type: "string" } } },
      },
    },
  ]);

  const relPath = path.join("webwrapper-eval", "tmp", "rewrite-write-to-edit.txt");
  fs.mkdirSync(path.dirname(relPath), { recursive: true });
  fs.writeFileSync(relPath, "old\n", "utf8");

  const toolCalls: any[] = [
    {
      id: "call_write_existing",
      type: "function",
      function: {
        name: "write",
        arguments: JSON.stringify({ filePath: relPath, content: "new\n" }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
  assert.equal(toolCalls[0]?.function?.name, "edit");
  const rewrittenArgs = JSON.parse(String(toolCalls[0].function.arguments));
  assert.equal(rewrittenArgs.filePath, relPath);
  assert.equal(rewrittenArgs.oldString, "old\n");
  assert.equal(rewrittenArgs.newString, "new\n");
});

test("heuristic shell command with chained operators is blocked", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "run_shell",
        parameters: { properties: { command: { type: "string" } } },
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
        arguments: JSON.stringify({ command: "rg TODO src; touch /tmp/pwned" }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "heuristic", registry);
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("Expected mutation_requires_planner_json");
  }
  assert.equal(result.reason, "mutation_requires_planner_json");
});

test("validatePlannerActions tolerates duplicate actions (dedupe happens later)", () => {
  const result = validatePlannerActions([
    { tool: "read", args: { path: "README.md" } },
    { tool: "read", args: { path: "README.md" } },
  ]);
  assert.equal(result.ok, true);
});

test("heuristic read-only shell command is allowed", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "run_shell",
        parameters: { properties: { command: { type: "string" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_test_read_only",
      index: 0,
      type: "function",
      function: {
        name: "run_shell",
        arguments: JSON.stringify({ command: "cat README.md" }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "heuristic", registry);
  assert.equal(result.ok, true);
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

test("model-emitted guard-confirmation question is blocked", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "question",
        parameters: { properties: { questions: { type: "array" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_question_replay",
      index: 0,
      type: "function",
      function: {
        name: "question",
        arguments: JSON.stringify({
          questions: [
            {
              header: "Confirm",
              id: "confirm_test",
              question: 'Confirm overriding guard "command_blocked" for command: "cargo build --release"',
            },
          ],
        }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "raw", registry);
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("Expected reserved_confirmation_prompt");
  }
  assert.equal(result.reason, "reserved_confirmation_prompt");
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

test("edit without an explicit path is tolerated for downstream recovery", () => {
  const registry = buildToolRegistry([
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
  ]);

  const toolCalls = [
    {
      id: "call_edit_missing_path",
      index: 0,
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({ oldString: "a", newString: "b" }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
});

test("list without explicit path defaults to workspace root", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "list",
        parameters: {
          properties: {
            path: { type: "string" },
          },
        },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_list_missing_path",
      index: 0,
      type: "function",
      function: {
        name: "list",
        arguments: JSON.stringify({}),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
  const rewrittenArgs = JSON.parse(String(toolCalls[0].function.arguments));
  assert.equal(rewrittenArgs.path, ".");
});

test("read without explicit path defaults to workspace root", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: {
          properties: {
            path: { type: "string" },
          },
        },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_read_missing_path",
      index: 0,
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({}),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
  const rewrittenArgs = JSON.parse(String(toolCalls[0].function.arguments));
  assert.equal(rewrittenArgs.path, ".");
});

test("glob accepts brace numeric ranges", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "glob",
        parameters: {
          properties: {
            pattern: { type: "string" },
          },
        },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_glob_brace_range",
      index: 0,
      type: "function",
      function: {
        name: "glob",
        arguments: JSON.stringify({ pattern: "src/file{1..3}.ts" }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
});

test("apply_patch with outside-workspace target in patch text is blocked", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "apply_patch",
        parameters: { properties: { patch: { type: "string" } } },
      },
    },
  ]);

  const patch = [
    "*** Begin Patch",
    "*** Update File: ../../etc/passwd",
    "@@",
    "-root:x:0:0",
    "+root:x:0:0:patched",
    "*** End Patch",
  ].join("\n");
  const toolCalls = [
    {
      id: "call_apply_patch_outside",
      index: 0,
      type: "function",
      function: {
        name: "apply_patch",
        arguments: JSON.stringify({ patch }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("Expected path_outside_workspace guard failure");
  }
  assert.equal(result.reason, "path_outside_workspace");
});

test("apply_patch without explicit target path is tolerated for downstream recovery", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "apply_patch",
        parameters: { properties: { patch: { type: "string" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_apply_patch_missing_path",
      index: 0,
      type: "function",
      function: {
        name: "apply_patch",
        arguments: JSON.stringify({
          patch: "*** Begin Patch\n@@\n-old\n+new\n*** End Patch",
        }),
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "planner", registry);
  assert.equal(result.ok, true);
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

test("write missing content is confirmable when question tool exists", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "write",
        parameters: { properties: { filePath: { type: "string" }, content: { type: "string" } } },
      },
    },
    {
      function: {
        name: "question",
        parameters: { properties: { question: { type: "string" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_write_missing_content",
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
  assert.equal(result.reason, "confirmation_required");
  assert.equal(result.pendingConfirmation?.blockedReason, "missing_content");
});

test("write with common malformed JSON arguments is recovered", () => {
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
  assert.equal(result.ok, true);
  const rewrittenArgs = JSON.parse(String(toolCalls[0].function.arguments));
  assert.equal(rewrittenArgs.filePath, "snake_game/src/main.rs");
  assert.equal(String(rewrittenArgs.content).includes("println!(\"oops\")"), true);
});

test("write with irrecoverable malformed arguments is blocked directly", () => {
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
      id: "call_write_bad_irrecoverable",
      index: 0,
      type: "function",
      function: {
        name: "write",
        arguments: "{\"filePath\":\"snake_game/src/main.rs\",\"content\":\"unterminated\"",
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "raw", registry);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_tool_args");
  assert.equal(Array.isArray(result.confirmationToolCalls), false);
});

test("invalid tool args are confirmable when question tool exists", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
    {
      function: {
        name: "question",
        parameters: { properties: { question: { type: "string" } } },
      },
    },
  ]);

  const toolCalls = [
    {
      id: "call_read_invalid_args",
      index: 0,
      type: "function",
      function: {
        name: "read",
        arguments: "prefix {\"path\":\"README.md\"} suffix",
      },
    },
  ];

  const result = validateToolCalls(toolCalls, "raw", registry);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "confirmation_required");
  assert.equal(result.pendingConfirmation?.blockedReason, "invalid_tool_args");
});

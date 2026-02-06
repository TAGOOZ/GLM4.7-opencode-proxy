import test from "node:test";
import assert from "node:assert/strict";
import { buildToolRegistry } from "../src/proxy/tools/registry.js";
import {
  inferReadToolCall,
  inferListToolCall,
  inferSearchToolCall,
} from "../src/proxy/tools/infer.js";

const toolRegistry = buildToolRegistry([
  {
    function: {
      name: "read",
      parameters: { properties: { filePath: { type: "string" } } },
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
      name: "glob",
      parameters: { properties: { pattern: { type: "string" } } },
    },
  },
  {
    function: {
      name: "run_shell",
      parameters: { properties: { command: { type: "string" } } },
    },
  },
  {
    function: {
      name: "write",
      parameters: { properties: { filePath: { type: "string" }, content: { type: "string" } } },
    },
  },
  {
    function: {
      name: "apply_patch",
      parameters: { properties: { patch: { type: "string" } } },
    },
  },
] as any);

const collectHeuristicCalls = (text: string) => {
  return [
    inferReadToolCall(toolRegistry, text),
    inferListToolCall(toolRegistry, text),
    inferSearchToolCall(toolRegistry, text),
  ].filter(Boolean) as any[];
};

test("heuristics never emit mutation tools from user text", () => {
  const mutationPrompts = [
    "create folder foo",
    "make directory bar",
    "delete file secrets.txt",
    "remove directory tmp",
    "write file a.txt with content hello",
    "apply patch to main.py",
    "run rm -rf /",
    "move a.txt to b.txt",
    "mkdir -p build",
  ];
  for (const prompt of mutationPrompts) {
    const calls = collectHeuristicCalls(prompt);
    for (const call of calls) {
      const name = String(call[0]?.function?.name || call[0]?.name || "").toLowerCase();
      assert.notStrictEqual(name, "write");
      assert.notStrictEqual(name, "apply_patch");
      assert.notStrictEqual(name, "edit");
      assert.notStrictEqual(name, "run_shell");
      assert.notStrictEqual(name, "run");
    }
  }
});

test("read heuristic only triggers on explicit read verbs", () => {
  const call = inferReadToolCall(toolRegistry, "read README.md");
  assert.ok(call);
  const name = String(call[0]?.function?.name || "").toLowerCase();
  assert.strictEqual(name, "read");

  const noCall = inferReadToolCall(toolRegistry, "what is in README.md");
  assert.strictEqual(noCall, null);
});

test("search heuristic only emits grep/rg run_shell", () => {
  const call = inferSearchToolCall(toolRegistry, "search for TODO in src");
  assert.ok(call);
  const name = String(call[0]?.function?.name || "").toLowerCase();
  assert.strictEqual(name, "run_shell");
  const args = JSON.parse(call[0].function.arguments);
  const cmd = String(args.command || "");
  assert.ok(/^(rg|ripgrep|grep)\b/i.test(cmd));
});

import test from "node:test";
import assert from "node:assert/strict";

import { buildToolRegistry } from "../src/proxy/tools/registry.js";
import { parseRawToolCalls } from "../src/proxy/tools/parse.js";
import { validateToolCalls } from "../src/proxy/handler/guards.js";

test("parseRawToolCalls preserves write path/content from malformed multiline arguments string", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "write",
        parameters: { properties: { path: { type: "string" }, content: { type: "string" } } },
      },
    },
  ]);

  const malformedArgs = `{"filePath":"snake-game-rust/src/main.rs","content":"use crossterm::{
    event::{self, Event, KeyCode},
};
fn main() {
    println!(\\"Hello, world!\\");
}
"}`;
  const encodedArgs = malformedArgs.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const raw = `[{"id":"call_1","type":"function","function":{"name":"write","arguments":"${encodedArgs}"}}]`;

  const calls = parseRawToolCalls(raw, registry);
  assert.ok(Array.isArray(calls));
  assert.equal(calls?.length, 1);

  const args = JSON.parse(String(calls?.[0]?.function?.arguments || "{}"));
  assert.equal(args.path, "snake-game-rust/src/main.rs");
  assert.equal(typeof args.content, "string");
  assert.equal(String(args.content).includes("println!(\"Hello, world!\");"), true);
});

test("validateToolCalls recovers common malformed write arguments strings", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "write",
        parameters: { properties: { filePath: { type: "string" }, content: { type: "string" } } },
      },
    },
  ]);

  // Invalid JSON: unescaped quote in content.
  const badArgs = '{"filePath":"snake-game/src/main.rs","content":"println!("oops")"}';
  const encodedArgs = badArgs.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const raw = `[{"id":"call_1","type":"function","function":{"name":"write","arguments":"${encodedArgs}"}}]`;

  const calls = parseRawToolCalls(raw, registry);
  assert.ok(Array.isArray(calls));
  assert.equal(calls?.length, 1);
  const guarded = validateToolCalls(calls || [], "raw", registry);
  assert.equal(guarded.ok, true);
  const rewritten = JSON.parse(String(calls?.[0]?.function?.arguments || "{}"));
  assert.equal(rewritten.filePath, "snake-game/src/main.rs");
  assert.equal(String(rewritten.content).includes("println!(\"oops\")"), true);
});

test("validateToolCalls repairs multiline raw edit arguments and allows execution", () => {
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

  const malformedArgs =
    "{\"filePath\":\"snake_game/Cargo.toml\",\"oldString\":\"[dependencies]\",\"newString\":\"[dependencies]\n" +
    "crossterm = \\\"0.28\\\"\n" +
    "rand = \\\"0.8\\\"\"}";
  const toolCalls = [
    {
      id: "call_1",
      index: 0,
      type: "function",
      function: {
        name: "edit",
        arguments: malformedArgs,
      },
    },
  ];

  const guarded = validateToolCalls(toolCalls as any, "raw", registry);
  assert.equal(guarded.ok, true);

  const rewrittenArgs = JSON.parse(String((toolCalls as any)[0]?.function?.arguments || "{}"));
  assert.equal(rewrittenArgs.filePath, "snake_game/Cargo.toml");
  assert.equal(rewrittenArgs.oldString, "[dependencies]");
  assert.equal(typeof rewrittenArgs.newString, "string");
  assert.equal(String(rewrittenArgs.newString).includes("crossterm = \"0.28\""), true);
});

test("parseRawToolCalls ignores prose that only contains tool-call examples", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);

  const prose =
    "Use this shape: {\"function\":{\"name\":\"read\",\"arguments\":{\"path\":\"README.md\"}}} but do not execute it.";
  const calls = parseRawToolCalls(prose, registry);
  assert.equal(calls, null);
});

test("parseRawToolCalls can recover tool calls from prose-wrapped JSON payloads", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);

  const prose =
    "Running requested action now.\n" +
    "[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":{\"path\":\"README.md\"}}}]\n" +
    "Done.";
  const calls = parseRawToolCalls(prose, registry);
  assert.ok(Array.isArray(calls));
  assert.equal(calls?.length, 1);
  assert.equal(calls?.[0]?.function?.name, "read");
  const args = JSON.parse(String(calls?.[0]?.function?.arguments || "{}"));
  assert.equal(args.path, "README.md");
});

test("parseRawToolCalls strict envelope mode rejects prose-wrapped JSON payloads", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);

  const prose =
    "Running requested action now.\n" +
    "[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":{\"path\":\"README.md\"}}}]\n" +
    "Done.";
  const calls = parseRawToolCalls(prose, registry, { allowProseEnvelope: false });
  assert.equal(calls, null);
});

test("parseRawToolCalls does not treat name-only JSON objects as executable calls", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);

  const raw = "{\"name\":\"read\",\"note\":\"this is documentation, not a call\"}";
  const calls = parseRawToolCalls(raw, registry);
  assert.equal(calls, null);
});

test("parseRawToolCalls does not treat function-name-only JSON objects as executable calls", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);

  const raw = "{\"function\":{\"name\":\"read\"},\"note\":\"schema example only\"}";
  const calls = parseRawToolCalls(raw, registry);
  assert.equal(calls, null);
});

test("parseRawToolCalls preserves non-object arguments so guards can reject", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);

  const raw = "[{\"function\":{\"name\":\"read\",\"arguments\":123}}]";
  const calls = parseRawToolCalls(raw, registry);
  assert.ok(Array.isArray(calls));
  assert.equal(calls?.length, 1);
  assert.equal(calls?.[0]?.function?.arguments, "123");

  const guarded = validateToolCalls(calls || [], "raw", registry);
  assert.equal(guarded.ok, false);
  if (guarded.ok) {
    assert.fail("Expected invalid_tool_args guard failure");
  }
  assert.equal(guarded.reason, "invalid_tool_args");
});

test("parseRawToolCalls preserves prose-contaminated argument strings for guard rejection", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);

  const raw =
    "[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"prefix {\\\"path\\\":\\\"README.md\\\"} suffix\"}}]";
  const calls = parseRawToolCalls(raw, registry);
  assert.ok(Array.isArray(calls));
  assert.equal(calls?.length, 1);
  assert.equal(calls?.[0]?.function?.arguments, "prefix {\"path\":\"README.md\"} suffix");

  const guarded = validateToolCalls(calls || [], "raw", registry);
  assert.equal(guarded.ok, false);
  if (guarded.ok) {
    assert.fail("Expected invalid_tool_args guard failure");
  }
  assert.equal(guarded.reason, "invalid_tool_args");
});

test("parseRawToolCalls text fallback skips function blocks without explicit arguments", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);

  const invalidJson = "{\"function\":{\"name\":\"read\"} \"type\":\"function\"}";
  const calls = parseRawToolCalls(invalidJson, registry);
  assert.equal(calls, null);
});

test("parseRawToolCalls text fallback still recovers malformed call with explicit arguments", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
  ]);

  const invalidJson =
    "{\"function\":{\"name\":\"read\",\"arguments\":{\"path\":\"README.md\"}} \"type\":\"function\"}";
  const calls = parseRawToolCalls(invalidJson, registry);
  assert.ok(Array.isArray(calls));
  assert.equal(calls?.length, 1);
  const args = JSON.parse(String(calls?.[0]?.function?.arguments || "{}"));
  assert.equal(args.path, "README.md");
});

test("validateToolCalls rejects prose-contaminated JSON argument strings", () => {
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
      id: "call_1",
      index: 0,
      type: "function",
      function: {
        name: "read",
        arguments: "prefix {\"path\":\"README.md\"} suffix",
      },
    },
  ];

  const guarded = validateToolCalls(toolCalls as any, "raw", registry);
  assert.equal(guarded.ok, false);
  if (guarded.ok) {
    assert.fail("Expected invalid_tool_args guard failure");
  }
  assert.equal(guarded.reason, "invalid_tool_args");
});

test("validateToolCalls keeps comment-like literals when repairing trailing commas", () => {
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
      id: "call_1",
      index: 0,
      type: "function",
      function: {
        name: "write",
        arguments: "{\"filePath\":\"x.txt\",\"content\":\"A/*keep*/B\",}",
      },
    },
  ];

  const guarded = validateToolCalls(toolCalls as any, "raw", registry);
  assert.equal(guarded.ok, true);

  const rewrittenArgs = JSON.parse(String((toolCalls as any)[0]?.function?.arguments || "{}"));
  assert.equal(rewrittenArgs.filePath, "x.txt");
  assert.equal(rewrittenArgs.content, "A/*keep*/B");
});

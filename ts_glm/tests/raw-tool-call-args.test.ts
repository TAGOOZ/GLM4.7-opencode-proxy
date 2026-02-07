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

test("parseRawToolCalls preserves malformed raw arguments string (does not coerce to {})", () => {
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
  assert.equal(calls?.[0]?.function?.name, "write");

  const argsRaw = String(calls?.[0]?.function?.arguments || "");
  assert.equal(argsRaw.includes("filePath"), true);
  assert.notEqual(argsRaw, "{}");

  const guarded = validateToolCalls(calls || [], "raw", registry);
  assert.equal(guarded.ok, false);
  if (guarded.ok) {
    assert.fail("Expected invalid_tool_args guard failure");
  }
  assert.equal(guarded.reason, "invalid_tool_args");
  assert.equal(Array.isArray(guarded.confirmationToolCalls), false);
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

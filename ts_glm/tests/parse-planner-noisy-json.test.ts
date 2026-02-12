import test from "node:test";
import assert from "node:assert/strict";

import { tryParseModelOutput, tryRepairPlannerOutput } from "../src/proxy/tools/parse.js";

const NOISY_RESPONSE = [
  "I found two syntax issues.",
  "1. Line 122 is missing opening brace `{` after return type.",
  "2. Line 272 is missing opening brace `{` after return type.",
  "",
  "Let me fix them now.",
  "",
  "{",
  '  "plan": ["Fix syntax errors"],',
  '  "actions": [',
  "    {",
  '      "tool": "edit",',
  '      "args": {',
  '        "filePath": "snake_game/src/main.rs",',
  '        "oldString": "fn main() -> Result<(), Box<dyn Error>n",',
  '        "newString": "fn main() -> Result<(), Box<dyn Error>> {"',
  "      },",
  '      "why": "Fix missing opening brace",',
  '      "expect": "File compiles",',
  '      "safety": { "risk": "low", "notes": "" }',
  "    }",
  "  ]",
  "}",
].join("\n");

test("tryParseModelOutput recovers JSON object when prose contains unmatched `{` markers", () => {
  const parsed = tryParseModelOutput(NOISY_RESPONSE, false);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.data) {
    assert.fail("expected parsed planner output");
  }
  assert.equal(parsed.data.actions.length, 1);
  assert.equal(parsed.data.actions[0]?.tool, "edit");
});

test("tryRepairPlannerOutput recovers JSON object when first extracted object is invalid", () => {
  const repaired = tryRepairPlannerOutput(NOISY_RESPONSE);
  assert.ok(repaired);
  assert.equal(repaired?.actions.length, 1);
  assert.equal(repaired?.actions[0]?.args?.filePath, "snake_game/src/main.rs");
});

test("tryParseModelOutput relaxed mode prefers the latest valid JSON object", () => {
  const raw = [
    "{\"plan\":[\"old\"],\"actions\":[],\"final\":\"old\"}",
    "Some non-JSON explanation in between.",
    "{\"plan\":[\"new\"],\"actions\":[],\"final\":\"new\"}",
  ].join("\n");

  const parsed = tryParseModelOutput(raw, true);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.data) {
    assert.fail("expected parsed planner output");
  }
  assert.equal(parsed.data.final, "new");
});

test("tryParseModelOutput recovers planner JSON after large non-JSON brace noise", () => {
  const noisyPrefix = Array.from({ length: 3000 }, (_, i) => `noise_${i} {broken marker`).join("\n");
  const raw = `${noisyPrefix}\n{"plan":["ok"],"actions":[],"final":"done"}`;

  const parsed = tryParseModelOutput(raw, false);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.data) {
    assert.fail("expected parsed planner output");
  }
  assert.equal(parsed.data.final, "done");
});

test("tryParseModelOutput salvages executable actions from malformed fenced planner JSON", () => {
  const raw = [
    "```json",
    "{",
    '  "plan": ["Build snake"],',
    '  "actions": [',
    "    {",
    '      "tool": "mkdir",',
    '      "args": { "path": "snake_game" },',
    '      "why": "",',
    '      "expect": "",',
    '      "safety": { "risk": "low", "notes": "" }',
    "    },",
    "    {",
    '      "tool": "run",',
    '      "args": { "cmd": "cargo init --name snake_game", "workdir": "snake_game" },',
    '      "why": "",',
    '      "expect": "",',
    '      "safety": { "risk": "low", "notes": "" }',
    "    },",
    "    {",
    '      "tool": "write",',
    '      "args": { "path": "snake_game/src/main.rs", "content": "fn main() { println!("broken"); }" },',
    '      "why": "",',
    '      "expect": "",',
    '      "safety": { "risk": "low", "notes": "" }',
    "    }",
    "  ]",
    "}",
    "```",
  ].join("\n");

  const parsed = tryParseModelOutput(raw, false);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.data) {
    assert.fail("expected salvaged planner output");
  }
  assert.ok(parsed.data.actions.length >= 2);
  assert.equal(parsed.data.actions[0]?.tool, "mkdir");
  assert.equal(parsed.data.actions[1]?.tool, "run");
});

test("tryParseModelOutput does not salvage malformed action examples from template context", () => {
  const raw = [
    "Example only. Do not execute this template.",
    "```json",
    "{",
    '  "plan": ["template"],',
    '  "actions": [',
    '    { "tool": "run", "args": { "cmd": "echo sample", "workdir": "tmp" }, "why": "", "expect": "", "safety": { "risk": "low", "notes": "" } },',
    '    { "tool": "write", "args": { "path": "tmp/file.txt", "content": "bad " quote" }, "why": "", "expect": "", "safety": { "risk": "low", "notes": "" } }',
    "  ]",
    "}",
    "```",
  ].join("\n");

  const parsed = tryParseModelOutput(raw, false);
  assert.equal(parsed.ok, false);
});

test("tryParseModelOutput drops malformed actions and preserves final when no valid actions remain", () => {
  const raw = JSON.stringify({
    plan: ["answer directly"],
    actions: [{ bad: "shape" }, { tool: "", args: {} }],
    final: "done",
  });

  const parsed = tryParseModelOutput(raw, false);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.data) {
    assert.fail("expected parsed planner output");
  }
  assert.equal(parsed.data.actions.length, 0);
  assert.equal(parsed.data.final, "done");
});

test("tryParseModelOutput rejects non-string final when actions are empty", () => {
  const raw = JSON.stringify({
    plan: ["answer directly"],
    actions: [],
    final: true,
  });

  const parsed = tryParseModelOutput(raw, false);
  assert.equal(parsed.ok, false);
});

test("tryParseModelOutput coerces function-style planner actions into tool+args actions", () => {
  const raw = JSON.stringify({
    plan: ["list files"],
    actions: [
      {
        type: "function",
        function: {
          name: "exec",
          arguments: "{\"cmd\":\"ls\",\"workdir\":\".\"}",
        },
      },
    ],
  });

  const parsed = tryParseModelOutput(raw, false);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.data) {
    assert.fail("expected parsed planner output");
  }
  assert.equal(parsed.data.actions.length, 1);
  assert.equal(parsed.data.actions[0]?.tool, "exec");
  assert.equal(parsed.data.actions[0]?.args?.cmd, "ls");
});

test("tryParseModelOutput accepts fenced OpenAI-style final tool-call arrays as final output", () => {
  const raw = [
    "```json",
    JSON.stringify([
      {
        id: "call_final_result",
        type: "function",
        function: {
          name: "final",
          arguments: JSON.stringify({ text: "BENCH_OK calculator" }),
        },
      },
    ]),
    "```",
  ].join("\n");

  const parsed = tryParseModelOutput(raw, false);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.data) {
    assert.fail("expected parsed final output");
  }
  assert.equal(parsed.data.actions.length, 0);
  assert.equal(parsed.data.final, "BENCH_OK calculator");
});

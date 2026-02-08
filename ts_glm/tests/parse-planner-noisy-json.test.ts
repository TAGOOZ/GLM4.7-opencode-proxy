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

import test from "node:test";
import assert from "node:assert/strict";

import { buildToolRegistry } from "../src/proxy/tools/registry.js";
import { inferEditToolCall } from "../src/proxy/tools/infer.js";

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

test("inferEditToolCall returns null for multi-hunk patches", () => {
  const text = [
    "*** Begin Patch",
    "*** Update File: src/main.ts",
    "@@",
    "-const a = 1;",
    "+const a = 2;",
    "@@",
    "-const b = 1;",
    "+const b = 2;",
    "*** End Patch",
  ].join("\n");

  const inferred = inferEditToolCall(registry, text);
  assert.equal(inferred, null);
});

test("inferEditToolCall keeps context lines for single-hunk replacements", () => {
  const text = [
    "*** Begin Patch",
    "*** Update File: src/main.ts",
    "@@",
    " const start = true;",
    "-const answer = 41;",
    "+const answer = 42;",
    " const end = true;",
    "*** End Patch",
  ].join("\n");

  const inferred = inferEditToolCall(registry, text);
  assert.ok(inferred);
  const args = JSON.parse(String(inferred?.[0]?.function?.arguments || "{}"));
  assert.equal(args.filePath, "src/main.ts");
  assert.equal(args.oldString.includes("const start = true;"), true);
  assert.equal(args.oldString.includes("const answer = 41;"), true);
  assert.equal(args.newString.includes("const answer = 42;"), true);
  assert.equal(args.newString.includes("const end = true;"), true);
});

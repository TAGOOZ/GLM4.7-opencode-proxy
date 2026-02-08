import test from "node:test";
import assert from "node:assert/strict";

import { inferExplicitToolCalls } from "../src/proxy/tools/inferExplicitToolCalls.js";
import { buildToolRegistry } from "../src/proxy/tools/registry.js";

test("inferExplicitToolCalls parses unquoted key=value arguments", () => {
  const registry = buildToolRegistry([
    {
      function: {
        name: "read",
        parameters: { properties: { path: { type: "string" }, status: { type: "string" } } },
      },
    },
  ]);

  const calls = inferExplicitToolCalls(registry, "% read path=src/main.ts status=ok");
  assert.ok(Array.isArray(calls));
  assert.equal(calls?.length, 1);

  const args = JSON.parse(String(calls?.[0]?.function?.arguments || "{}"));
  assert.equal(args.path, "src/main.ts");
  assert.equal(args.status, "ok");
});

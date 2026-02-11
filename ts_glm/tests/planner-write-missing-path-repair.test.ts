import test from "node:test";
import assert from "node:assert/strict";

test("planner write without path is repaired when PROXY_REPAIR_WRITE_MISSING_PATH=1", async () => {
  const prev = process.env.PROXY_REPAIR_WRITE_MISSING_PATH;
  process.env.PROXY_REPAIR_WRITE_MISSING_PATH = "1";
  try {
    const { buildPlannerActionToolCall } = await import("../src/proxy/handler/plannerActions.js");
    const { buildToolRegistry } = await import("../src/proxy/tools/registry.js");

    const toolRegistry = buildToolRegistry([
      {
        function: {
          name: "write",
          parameters: { properties: { filePath: { type: "string" }, content: { type: "string" } } },
        },
      },
    ]);

    const call = buildPlannerActionToolCall({
      action: { tool: "write", args: { content: "fn main() {}\n" } },
      index: 0,
      toolRegistry,
      sanitizedMessages: [
        { role: "user", content: "Implement code in src/main.rs and ensure it compiles." },
      ],
    });

    const args = JSON.parse(String(call.function.arguments));
    assert.equal(args.filePath, "src/main.rs");
    assert.equal(typeof args.content, "string");
  } finally {
    if (prev == null) delete process.env.PROXY_REPAIR_WRITE_MISSING_PATH;
    else process.env.PROXY_REPAIR_WRITE_MISSING_PATH = prev;
  }
});


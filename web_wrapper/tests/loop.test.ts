import { describe, it, expect } from "vitest";
import { runProtocol } from "../src/loop.js";
import type { ModelClient, ToolRunner } from "../src/types.js";

const fakeModel = (outputs: string[]): ModelClient => {
  let idx = 0;
  return {
    call: async () => outputs[Math.min(idx++, outputs.length - 1)],
  };
};

describe("loop", () => {
  it("retries invalid json", async () => {
    const outputs = ["not json", JSON.stringify({ plan: ["x"], actions: [], final: "ok" })];
    const result = await runProtocol({
      userRequest: "hi",
      model: fakeModel(outputs),
      tools: [],
      toolDefinitions: [],
      config: { strictJson: false },
    });
    expect(result.final).toBe("ok");
  });

  it("handles unknown tool", async () => {
    const outputs = [
      JSON.stringify({
        plan: ["do"],
        actions: [{ tool: "missing", args: {}, why: "x", expect: "y", safety: { risk: "low", notes: "ok" } }]
      }),
      JSON.stringify({ plan: ["done"], actions: [], final: "finished" })
    ];
    const result = await runProtocol({
      userRequest: "hi",
      model: fakeModel(outputs),
      tools: [],
      toolDefinitions: [],
      config: { strictJson: false, maxIterations: 5 },
    });
    expect(result.final).toBe("finished");
  });
});

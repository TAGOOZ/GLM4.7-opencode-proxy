import { describe, it, expect } from "vitest";
import { parseModelOutput } from "../src/parser.js";

const valid = {
  plan: ["step"],
  actions: [],
  final: "done",
};

describe("parser", () => {
  it("rejects non-json in strict mode", () => {
    const raw = "hello {\"plan\":[],\"actions\":[],\"final\":\"x\"}";
    const res = parseModelOutput(raw, true);
    expect(res.ok).toBe(false);
  });

  it("accepts valid json", () => {
    const raw = JSON.stringify(valid);
    const res = parseModelOutput(raw, true);
    expect(res.ok).toBe(true);
  });

  it("rejects final with actions", () => {
    const raw = JSON.stringify({ plan: ["a"], actions: [{
      tool: "read", args: {}, why: "x", expect: "y", safety: { risk: "low", notes: "ok" }
    }], final: "no" });
    const res = parseModelOutput(raw, true);
    expect(res.ok).toBe(false);
  });
});

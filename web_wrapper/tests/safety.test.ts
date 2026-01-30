import { describe, it, expect } from "vitest";
import { isCommandAllowed, DEFAULT_ALLOWLIST, DEFAULT_DENYLIST } from "../src/safety.js";

const config = {
  maxIterations: 1,
  maxActionsPerTurn: 1,
  timeoutMs: 1000,
  strictJson: true,
  allowNetwork: false,
  allowlistCommands: DEFAULT_ALLOWLIST,
  denylistPatterns: DEFAULT_DENYLIST,
  redactPatterns: [],
};

describe("safety", () => {
  it("blocks rm -rf", () => {
    const res = isCommandAllowed("rm -rf /", config);
    expect(res.ok).toBe(false);
  });

  it("blocks non-allowlisted command", () => {
    const res = isCommandAllowed("curl https://example.com", config);
    expect(res.ok).toBe(false);
  });

  it("allows ls", () => {
    const res = isCommandAllowed("ls -la", config);
    expect(res.ok).toBe(true);
  });
});

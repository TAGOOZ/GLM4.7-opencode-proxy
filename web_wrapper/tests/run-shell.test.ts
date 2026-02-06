import { describe, it, expect } from "vitest";
import { runShellTool } from "../src/tools.js";
import { DEFAULT_ALLOWLIST, DEFAULT_DENYLIST, DEFAULT_OUTPUT_LIMIT } from "../src/safety.js";

describe("runShellTool", () => {
  it("truncates large stdout/stderr", async () => {
    const tool = runShellTool(DEFAULT_ALLOWLIST, DEFAULT_DENYLIST);
    const ctx = {
      cwd: process.cwd(),
      timeoutMs: 5000,
      allowNetwork: false,
    };

    if (typeof process.getuid === "function" && process.getuid() === 0) {
      const res = await tool.run({ command: "node -e \"process.stdout.write('ok')\"" }, ctx);
      expect(res.ok).toBe(false);
      expect(res.error).toBe("unsafe_root");
      return;
    }

    const size = DEFAULT_OUTPUT_LIMIT + 70000;
    const command =
      `node -e "` +
      `require('fs').writeSync(1, 'a'.repeat(${size}));` +
      `require('fs').writeSync(2, 'b'.repeat(${size}));` +
      `"`;
    const res = await tool.run({ command }, ctx);

    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.truncated).toBe(true);
    expect(String(res.stdout)).toContain(`[truncated ${size - DEFAULT_OUTPUT_LIMIT} chars]`);
    expect(String(res.stderr)).toContain(`[truncated ${size - DEFAULT_OUTPUT_LIMIT} chars]`);
  });
});

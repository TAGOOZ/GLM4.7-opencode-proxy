import { describe, it, expect } from "vitest";
import { replayTranscript } from "../src/replay.js";
import type { ToolRunner, Transcript } from "../src/types.js";

const tool: ToolRunner = {
  name: "read",
  run: async (args) => ({ tool: "read", ok: true, echo: args.path }),
};

const transcript: Transcript = {
  messages: [],
  toolResults: [],
  modelOutputs: [
    {
      plan: ["read"],
      actions: [
        {
          tool: "read",
          args: { path: "file.txt" },
          why: "test",
          expect: "content",
          safety: { risk: "low", notes: "ok" },
        },
      ],
    },
  ],
  logs: [],
};

describe("replay", () => {
  it("replays tool actions", async () => {
    const results = await replayTranscript({ transcript, tools: [tool] });
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.echo).toBe("file.txt");
  });
});

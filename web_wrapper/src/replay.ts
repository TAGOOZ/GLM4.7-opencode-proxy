import type { ReplayOptions, ToolResult } from "./types.js";
import { JsonlLogger } from "./logger.js";
import { defaultRedactPatterns, redactToolResult } from "./safety.js";

const getRunner = (tool: string, runners: ReplayOptions["tools"]) => runners.find((t) => t.name === tool);

export const replayTranscript = async (options: ReplayOptions): Promise<ToolResult[]> => {
  const config = {
    timeoutMs: 120_000,
    allowNetwork: false,
    redactPatterns: defaultRedactPatterns(),
    ...options.config,
  };
  const logger = new JsonlLogger(options.config?.logPath);
  const results: ToolResult[] = [];

  for (let i = 0; i < options.transcript.modelOutputs.length; i += 1) {
    const output = options.transcript.modelOutputs[i];
    for (const action of output.actions) {
      const runner = getRunner(action.tool, options.tools);
      if (!runner) {
        results.push({ tool: action.tool, ok: false, error: "unknown_tool" });
        continue;
      }
      const result = await runner.run(action.args, {
        cwd: process.cwd(),
        timeoutMs: config.timeoutMs,
        allowNetwork: config.allowNetwork,
      });
      results.push(redactToolResult(result, config.redactPatterns));
    }
  }

  logger.log({
    iteration: -1,
    promptHash: "replay",
    modelRaw: "",
    parsed: undefined,
    actions: [],
    toolResults: results,
    stopReason: "replay_complete",
  });

  return results;
};

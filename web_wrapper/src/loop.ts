import { SYSTEM_PROMPT } from "./prompt.js";
import { parseModelOutput } from "./parser.js";
import { JsonlLogger } from "./logger.js";
import {
  DEFAULT_ALLOWLIST,
  DEFAULT_DENYLIST,
  defaultRedactPatterns,
  hashPrompt,
  redactToolResult,
} from "./safety.js";
import type {
  Action,
  ExecutionLogEntry,
  ModelOutput,
  ProtocolConfig,
  RunOptions,
  ToolResult,
  Transcript,
  Message,
  ToolRunner,
  ToolDefinition,
} from "./types.js";

const DEFAULT_CONFIG: ProtocolConfig = {
  maxIterations: 20,
  maxActionsPerTurn: 3,
  timeoutMs: 120_000,
  strictJson: true,
  allowNetwork: false,
  logPath: undefined,
  redactPatterns: defaultRedactPatterns(),
  allowlistCommands: DEFAULT_ALLOWLIST,
  denylistPatterns: DEFAULT_DENYLIST,
};

const buildToolCatalog = (toolDefinitions: ToolDefinition[]): string | null => {
  if (!toolDefinitions.length) return null;
  const tools = toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    argsSchema: tool.argsSchema || {},
  }));
  return `Available tools (JSON): ${JSON.stringify(tools)}`;
};

const buildPromptMessages = (
  userRequest: string,
  transcript: Transcript,
  toolDefinitions: ToolDefinition[]
): Message[] => {
  const messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];
  const toolCatalog = buildToolCatalog(toolDefinitions);
  if (toolCatalog) {
    messages.push({ role: "system", content: toolCatalog });
  }
  messages.push({ role: "user", content: userRequest });
  messages.push(...transcript.messages);
  return messages;
};

const asJsonResultsMessage = (results: ToolResult[]): Message => ({
  role: "tool",
  content: JSON.stringify(results),
});

const getRunner = (tool: string, runners: ToolRunner[]): ToolRunner | undefined => {
  return runners.find((t) => t.name === tool);
};

const sanitizeActions = (actions: Action[], limit: number): { actions: Action[]; truncated: boolean } => {
  if (actions.length <= limit) {
    return { actions, truncated: false };
  }
  return { actions: actions.slice(0, limit), truncated: true };
};

export const runProtocol = async (options: RunOptions): Promise<{ final: string; transcript: Transcript }> => {
  const config: ProtocolConfig = { ...DEFAULT_CONFIG, ...options.config };
  const logger = new JsonlLogger(config.logPath);

  const transcript: Transcript = options.transcript || {
    messages: [],
    toolResults: [],
    modelOutputs: [],
    logs: [],
  };

  for (let iteration = 0; iteration < config.maxIterations; iteration += 1) {
    const messages = buildPromptMessages(options.userRequest, transcript, options.toolDefinitions);
    const promptHash = hashPrompt(JSON.stringify(messages));

    let modelRaw = await options.model.call(messages);
    let parsed: ModelOutput | undefined;
    let stopReason = "";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = parseModelOutput(modelRaw, config.strictJson);
      if (result.ok && result.data) {
        parsed = result.data;
        break;
      }
      if (attempt === 2) {
        stopReason = `invalid_json: ${result.error}`;
        break;
      }
      const corrective: Message = {
        role: "assistant",
        content: "Return ONLY valid JSON following the schema. No extra text.",
      };
      modelRaw = await options.model.call([...messages, corrective]);
    }

    const logEntry: ExecutionLogEntry = {
      iteration,
      promptHash,
      modelRaw,
      stopReason: stopReason || "ok",
    };

    if (!parsed) {
      logEntry.stopReason = stopReason || "invalid_output";
      transcript.logs.push(logEntry);
      logger.log(logEntry);
      throw new Error(`Protocol failed: ${logEntry.stopReason}`);
    }

    transcript.modelOutputs.push(parsed);
    transcript.messages.push({ role: "assistant", content: JSON.stringify(parsed) });
    logEntry.parsed = parsed;

    if (parsed.actions.length === 0) {
      logEntry.stopReason = "final";
      transcript.logs.push(logEntry);
      logger.log(logEntry);
      return { final: parsed.final || "", transcript };
    }

    const { actions, truncated } = sanitizeActions(parsed.actions, config.maxActionsPerTurn);
    logEntry.actions = actions;

    const toolResults: ToolResult[] = [];
    for (const action of actions) {
      const runner = getRunner(action.tool, options.tools);
      if (!runner) {
        toolResults.push({ tool: action.tool, ok: false, error: "unknown_tool" });
        continue;
      }
      try {
        const result = await runner.run(action.args, {
          cwd: process.cwd(),
          timeoutMs: config.timeoutMs,
          allowNetwork: config.allowNetwork,
        });
        toolResults.push(result);
      } catch (err) {
        toolResults.push({ tool: action.tool, ok: false, error: (err as Error).message });
      }
    }

    if (truncated) {
      toolResults.push({
        tool: "_system",
        ok: false,
        error: "action_limit_exceeded",
        note: `Only first ${config.maxActionsPerTurn} actions executed. Continue in next turn.`,
      });
    }

    const redactedResults = toolResults.map((result) => redactToolResult(result, config.redactPatterns));
    logEntry.toolResults = redactedResults;
    transcript.toolResults = redactedResults;
    transcript.messages.push(asJsonResultsMessage(redactedResults));

    transcript.logs.push(logEntry);
    logger.log(logEntry);
  }

  throw new Error("Protocol failed: max_iterations_exceeded");
};

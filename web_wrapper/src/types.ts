export type RiskLevel = "low" | "medium" | "high";

export type Action = {
  tool: string;
  args: Record<string, unknown>;
  why: string;
  expect: string;
  safety: {
    risk: RiskLevel;
    notes: string;
  };
};

export type ModelOutput = {
  plan: string[];
  actions: Action[];
  final?: string;
  thought?: string;
};

export type ToolResult = {
  tool: string;
  ok: boolean;
  error?: string;
  note?: string;
  [key: string]: unknown;
};

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type ToolDefinition = {
  name: string;
  description?: string;
  argsSchema?: Record<string, unknown>;
};

export type ToolRunner = {
  name: string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

export type ToolContext = {
  cwd: string;
  timeoutMs: number;
  allowNetwork: boolean;
};

export type ProtocolConfig = {
  maxIterations: number;
  maxActionsPerTurn: number;
  timeoutMs: number;
  strictJson: boolean;
  allowNetwork: boolean;
  logPath?: string;
  redactPatterns: RegExp[];
  allowlistCommands: string[];
  denylistPatterns: RegExp[];
};

export type ExecutionLogEntry = {
  iteration: number;
  promptHash: string;
  modelRaw: string;
  parsed?: ModelOutput;
  actions?: Action[];
  toolResults?: ToolResult[];
  stopReason: string;
};

export type Transcript = {
  messages: Message[];
  toolResults: ToolResult[];
  modelOutputs: ModelOutput[];
  logs: ExecutionLogEntry[];
};

export type ModelClient = {
  call: (messages: Message[]) => Promise<string>;
};

export type RunOptions = {
  userRequest: string;
  tools: ToolRunner[];
  toolDefinitions: ToolDefinition[];
  model: ModelClient;
  config?: Partial<ProtocolConfig>;
  transcript?: Transcript;
};

export type ReplayOptions = {
  transcript: Transcript;
  tools: ToolRunner[];
  config?: Partial<ProtocolConfig>;
};

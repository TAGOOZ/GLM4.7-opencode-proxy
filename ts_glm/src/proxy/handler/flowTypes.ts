import type { FastifyReply } from "fastify";
import type { GLMClient } from "../../glmClient.js";
import type { ContextStats, getContextConfig } from "../context.js";
import type { RawDispatchContext } from "./rawToolCalls.js";
import type { ToolInfo } from "../tools/registry.js";

type ContextConfig = ReturnType<typeof getContextConfig>;

export type GuardAndSendToolCalls = (
  reply: FastifyReply,
  toolCalls: any[],
  model: string,
  stream: boolean,
  headers: Record<string, string>,
  usage: Record<string, number> | undefined,
  promptTokens: number,
  stats?: ContextStats,
  source?: "planner" | "raw" | "heuristic" | "explicit",
  registry?: Map<string, ToolInfo>,
  rawContext?: RawDispatchContext & { rawSignature?: string },
  reasoningContent?: string,
) => unknown;

type SendContent = (
  reply: FastifyReply,
  content: string,
  model: string,
  promptTokens: number,
  stats?: ContextStats,
) => unknown;

type SendStreamContent = (
  reply: FastifyReply,
  content: string,
  model: string,
  stats?: ContextStats,
  promptTokens?: number,
  reasoningContent?: string,
) => unknown;

export type PlannerFlowDeps = {
  client: GLMClient;
  contextConfig: ContextConfig;
  postToolSystem: string;
  guardAndSendToolCalls: GuardAndSendToolCalls;
  sendContent: SendContent;
  sendStreamContent: SendStreamContent;
};

export type FallbackFlowDeps = {
  client: GLMClient;
  guardAndSendToolCalls: GuardAndSendToolCalls;
  sendContent: SendContent;
  sendStreamContent: SendStreamContent;
};

export type PlannerFlowContext = {
  reply: FastifyReply;
  model: string;
  stream: boolean;
  streamHeaders: Record<string, string>;
  toolRegistry: Map<string, ToolInfo>;
  rawDispatchContext: RawDispatchContext;
  lastRawDispatchSignature: string;
  lastRawDispatchUser: string;
  lastUser: string;
  allowHeuristicTools: boolean;
  explicitToolCalls: any[] | null;
  inferredToolCall: any[] | null;
  toolChoiceRequired: boolean;
  tools: any[];
  messages: any[];
  sanitizedMessages: any[];
  hasToolResult: boolean;
  toolResultCount: number;
  maxToolLoops: number;
  allowTodoWrite: boolean;
  useHistoryThisRequest: boolean;
  glmMessages: { role: string; content: string }[];
  glmStats: ContextStats;
  responsePromptTokens: number;
  collectModelResponse: (
    chatId: string,
    requestMessages: { role: string; content: string }[],
    options?: { parentMessageId?: string | null },
  ) => Promise<string>;
  getChatId: () => Promise<string>;
  thinkingRef: { value: string };
};

export type StreamFallbackContext = {
  reply: FastifyReply;
  model: string;
  tools: any[];
  glmMessages: { role: string; content: string }[];
  glmStats: ContextStats;
  responsePromptTokens: number;
  streamHeaders: Record<string, string>;
  toolRegistry: Map<string, ToolInfo>;
  rawDispatchContext: RawDispatchContext;
  lastRawDispatchSignature: string;
  lastRawDispatchUser: string;
  collectModelResponse: (chatId: string, requestMessages: { role: string; content: string }[]) => Promise<string>;
  getChatId: () => Promise<string>;
  useHistoryThisRequest: boolean;
  enableThinkingFinal: boolean;
  featureOverrides: Record<string, unknown>;
  thinkingRef: { value: string };
};

export type NonStreamFallbackContext = {
  reply: FastifyReply;
  model: string;
  tools: any[];
  glmMessages: { role: string; content: string }[];
  glmStats: ContextStats;
  responsePromptTokens: number;
  toolRegistry: Map<string, ToolInfo>;
  rawDispatchContext: RawDispatchContext;
  lastRawDispatchSignature: string;
  lastRawDispatchUser: string;
  collectModelResponse: (chatId: string, requestMessages: { role: string; content: string }[]) => Promise<string>;
  getChatId: () => Promise<string>;
  thinkingRef: { value: string };
};

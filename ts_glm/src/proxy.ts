#!/usr/bin/env node
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { GLMClient } from "./glmClient.js";
import { loadToken } from "./config.js";
import crypto from "crypto";
import { SYSTEM_PROMPT, parseModelOutput } from "web-wrapper-protocol";

const app = Fastify();
app.register(cors, { origin: true });

const token = loadToken();
if (!token) {
  console.error("Missing GLM token. Set GLM_TOKEN or run 'glm config --token'.");
  process.exit(1);
}

const client = new GLMClient(token);
let proxyChatId: string | null = null;

const ensureChat = async (): Promise<string> => {
  if (process.env.PROXY_NEW_CHAT_PER_REQUEST === "1" || !proxyChatId) {
    const chat = await client.createChat("OpenCode Proxy", "glm-4.7");
    proxyChatId = chat.id;
  }
  return proxyChatId;
};

const buildToolPrompt = (tools: any[]): string => {
  const lines = [SYSTEM_PROMPT, "", "Allowed tools:"];
  for (const tool of tools) {
    const fn = tool.function || {};
    const name = fn.name || tool.name || "tool";
    lines.push(`- ${name}: ${fn.description || ""}`.trim());
    if (fn.parameters) {
      lines.push(`  parameters: ${JSON.stringify(fn.parameters)}`);
    }
  }
  lines.push("");
  lines.push("Examples (format only):");
  lines.push(
    JSON.stringify({
      plan: ["inspect file"],
      actions: [
        {
          tool: "TOOL_NAME",
          args: { path: "README.md" },
          why: "need the file contents",
          expect: "file text",
          safety: { risk: "low", notes: "" },
        },
      ],
    })
  );
  lines.push(
    JSON.stringify({
      plan: ["answer directly"],
      actions: [],
      final: "Concise response to the user.",
    })
  );
  return lines.join("\n");
};

const normalizeToolName = (name: string) => name.toLowerCase().replace(/[_-]/g, "");

const isNameMatch = (target: string, candidate: string) => {
  if (candidate === target) return true;
  if (candidate.startsWith(target)) return true;
  if (candidate === `${target}file`) return true;
  if (candidate === `${target}dir`) return true;
  return false;
};

type ToolInfo = {
  tool: any;
  argKeys: string[];
};

const ARG_SYNONYMS: Record<string, string> = {
  filepath: "path",
  file_path: "path",
  filename: "path",
  file: "path",
  cmd: "command",
};

const TOOL_NAME_ALIASES: Record<string, string[]> = {
  read: ["read_file", "readfile", "open_file"],
  write: ["write_file", "writefile", "save_file", "create_file"],
  list: ["list_dir", "listdir"],
  run: ["run_shell", "shell", "bash"],
};

const collectToolNames = (tool: any): string[] => {
  const names: string[] = [];
  const fn = tool.function || {};
  if (fn.name) names.push(fn.name);
  if (fn.tool?.name) names.push(fn.tool.name);
  if (tool.name) names.push(tool.name);
  return names;
};

const collectArgKeys = (tool: any): string[] => {
  const props =
    tool?.function?.parameters?.properties ||
    tool?.parameters?.properties ||
    tool?.function?.tool?.parameters?.properties ||
    {};
  return Object.keys(props);
};

const buildToolRegistry = (tools: any[]): Map<string, ToolInfo> => {
  const registry = new Map<string, ToolInfo>();
  for (const tool of tools) {
    const argKeys = collectArgKeys(tool);
    const info: ToolInfo = { tool, argKeys };
    for (const name of collectToolNames(tool)) {
      const normalized = normalizeToolName(name);
      if (!registry.has(normalized)) {
        registry.set(normalized, info);
      }
    }
  }
  for (const [canonical, aliases] of Object.entries(TOOL_NAME_ALIASES)) {
    const allNames = [canonical, ...aliases];
    let info: ToolInfo | undefined;
    for (const name of allNames) {
      const match = registry.get(normalizeToolName(name));
      if (match) {
        info = match;
        break;
      }
    }
    if (!info) continue;
    for (const name of allNames) {
      const normalized = normalizeToolName(name);
      if (!registry.has(normalized)) {
        registry.set(normalized, info);
      }
    }
  }
  return registry;
};

const findTool = (registry: Map<string, ToolInfo>, name: string): ToolInfo | null => {
  const target = normalizeToolName(name);
  const direct = registry.get(target);
  if (direct) return direct;
  for (const [candidate, info] of registry.entries()) {
    if (isNameMatch(target, candidate)) return info;
  }
  return null;
};

const normalizeArgsForTool = (toolInfo: ToolInfo | null, args: Record<string, unknown>): Record<string, unknown> => {
  const allowed = toolInfo?.argKeys || [];
  if (!allowed.length) return args;
  const allowedNorm = new Map<string, string>();
  for (const key of allowed) {
    allowedNorm.set(normalizeToolName(key), key);
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const keyNorm = normalizeToolName(key);
    const direct = allowedNorm.get(keyNorm);
    if (direct) {
      normalized[direct] = value;
      continue;
    }
    if (keyNorm === "path" && allowedNorm.has("filepath")) {
      normalized[allowedNorm.get("filepath") as string] = value;
      continue;
    }
    const synonym = ARG_SYNONYMS[keyNorm];
    if (synonym) {
      const synKey = allowedNorm.get(normalizeToolName(synonym));
      if (synKey) {
        normalized[synKey] = value;
        continue;
      }
    }
    normalized[key] = value;
  }
  return normalized;
};

const stripFences = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  return trimmed;
};

const extractJsonBlock = (text: string, openChar: string, closeChar: string): string | null => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === openChar) {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
};

const parseRawJson = (raw: string): any | null => {
  const cleaned = stripFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    // try arrays first (tool_calls often output as arrays)
    const arrayBlock = extractJsonBlock(cleaned, "[", "]");
    if (arrayBlock) {
      try {
        return JSON.parse(arrayBlock);
      } catch {
        // ignore
      }
    }
    const objectBlock = extractJsonBlock(cleaned, "{", "}");
    if (objectBlock) {
      try {
        return JSON.parse(objectBlock);
      } catch {
        // ignore
      }
    }
  }
  return null;
};

const parseRawToolCalls = (raw: string, registry: Map<string, ToolInfo>) => {
  const data = parseRawJson(raw);
  if (!data) return null;
  let calls: any[] = [];
  if (Array.isArray(data)) {
    calls = data;
  } else if (Array.isArray(data.tool_calls)) {
    calls = data.tool_calls;
  } else if (data.tool && data.arguments !== undefined) {
    calls = [{ tool: data.tool, arguments: data.arguments }];
  } else if (data.function || data.name) {
    calls = [data];
  } else {
    return null;
  }

  const toolCalls = [];
  for (const call of calls) {
    const func = call.function || call;
    const rawName = func?.name || call.name || call.tool;
    if (!rawName) continue;
    const toolInfo = findTool(registry, rawName);
    if (!toolInfo) continue;
    let args = func?.arguments ?? call.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (!args || typeof args !== "object") {
      args = {};
    }
    args = normalizeArgsForTool(toolInfo, args as Record<string, unknown>);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || rawName;
    toolCalls.push({
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: toolCalls.length,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(args),
      },
    });
  }
  return toolCalls.length ? toolCalls : null;
};

const pickArgKey = (toolInfo: ToolInfo | null, candidates: string[]): string => {
  const argKeys = toolInfo?.argKeys || [];
  for (const key of candidates) {
    if (argKeys.includes(key)) return key;
  }
  return candidates[0];
};

const extractFilePath = (text: string): string | null => {
  let normalized = text.trim();
  if (
    (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
    (normalized.startsWith("'") && normalized.endsWith("'")) ||
    (normalized.startsWith("`") && normalized.endsWith("`"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  const fileMatches = [...normalized.matchAll(/([A-Za-z0-9_./-]+\\.[A-Za-z0-9]{1,10})/g)];
  if (fileMatches.length) {
    return fileMatches[fileMatches.length - 1][1];
  }
  const matches = [...normalized.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)];
  if (matches.length) {
    let candidate = matches[matches.length - 1].slice(1).find(Boolean) as string | undefined;
    if (candidate) {
      candidate = candidate.replace(/[.,:;!?)]$/, "");
      const lowered = candidate.toLowerCase();
      if (lowered.startsWith("read ") || lowered.startsWith("open ") || lowered.startsWith("show ") || lowered.startsWith("cat ")) {
        candidate = candidate.replace(/^(read|open|show|cat)\s+/i, "");
      }
      return candidate;
    }
  }
  const tokens = normalized.split(/\s+/).map((t) => t.replace(/[.,:;!?)]$/, ""));
  const token = tokens.find((t) => /\.[A-Za-z0-9]{1,10}$/.test(t));
  return token || null;
};

const looksLikePath = (value: string | null): boolean => {
  if (!value) return false;
  if (/\s/.test(value)) return false;
  if (value.startsWith("~") || value.startsWith(".") || value.includes("/") || value.includes("\\")) return true;
  if (/\.[A-Za-z0-9]{1,10}$/.test(value)) return true;
  return false;
};

const inferReadToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const lowered = userText.toLowerCase();
  const readIntent = ["read", "open", "show", "cat", "contents", "what is in", "what's in", "display"];
  const path = extractFilePath(userText);
  const hasReadIntent = readIntent.some((k) => lowered.includes(k));
  if (!hasReadIntent) return null;
  const toolInfo = findTool(registry, "read") || findTool(registry, "read_file");
  if (!toolInfo) return null;
  if (!path) return null;
  const key = pickArgKey(toolInfo, ["filePath", "path"]);
  const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "read";
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify({ [key]: path }) },
    },
  ];
};

const inferWriteToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const toolInfo = findTool(registry, "write") || findTool(registry, "write_file");
  if (!toolInfo) return null;
  const patterns = [
    /create (?:a )?file\s+([\w./-]+)\s+with content\s+([\s\S]+)/i,
    /create (?:a )?file\s+([\w./-]+)\s+with\s+([\s\S]+)/i,
    /write\s+([\s\S]+?)\s+to\s+([\w./-]+)/i,
    /save\s+([\w./-]+)\s+content\s+([\s\S]+)/i,
  ];
  for (const pattern of patterns) {
    const match = userText.match(pattern);
    if (!match) continue;
    let filePath = match[1];
    let content = match[2];
    if (pattern === patterns[2]) {
      filePath = match[2];
      content = match[1];
    }
    filePath = filePath.replace(/^[\"'`]/, "").replace(/[\"'`].*$/, "");
    content = content.replace(/^[\"'`]/, "").replace(/[\"'`]$/, "");
    if (!filePath || !content) continue;
    const pathKey = pickArgKey(toolInfo, ["filePath", "path"]);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "write";
    return [
      {
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        index: 0,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify({ [pathKey]: filePath, content }) },
      },
    ];
  }
  // Fallback: "create file X" without content -> use placeholder
  const simple = userText.match(/create (?:a )?file\s+([\w./-]+)/i);
  if (simple && simple[1]) {
    const filePath = simple[1];
    const pathKey = pickArgKey(toolInfo, ["filePath", "path"]);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || "write";
    return [
      {
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        index: 0,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify({ [pathKey]: filePath, content: "" }) },
      },
    ];
  }
  return null;
};

const inferListToolCall = (registry: Map<string, ToolInfo>, userText: string) => {
  const lowered = userText.toLowerCase();
  const listIntent = ["list files", "list folders", "list directory", "show files", "inspect files"];
  const hasLsToken = /\bls\b/.test(lowered);
  if (!hasLsToken && !listIntent.some((k) => lowered.includes(k))) return null;
  const toolInfo = findTool(registry, "glob") || findTool(registry, "list") || findTool(registry, "list_dir");
  if (!toolInfo) return null;
  const key = pickArgKey(toolInfo, ["pattern", "path"]);
  const args = key === "pattern" ? { [key]: "**/*" } : { [key]: "." };
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolInfo.tool.function?.name || toolInfo.tool.name || "glob", arguments: JSON.stringify(args) },
    },
  ];
};

const convertMessages = (messages: any[], tools: any[]): { role: string; content: string }[] => {
  const out: { role: string; content: string }[] = [];
  if (tools.length) {
    out.push({ role: "system", content: buildToolPrompt(tools) });
  }
  for (const msg of messages) {
    if (msg.role === "tool") {
      const rawContent = msg.content ?? "";
      const content =
        typeof rawContent === "object" ? JSON.stringify(rawContent) : String(rawContent || "");
      out.push({ role: "user", content: `Tool result (${msg.name || "tool"}):\n${content}` });
      continue;
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      out.push({ role: "assistant", content: JSON.stringify(msg.tool_calls) });
      continue;
    }
    out.push({ role: msg.role, content: msg.content || "" });
  }
  return out;
};

const collectGlmResponse = async (
  chatId: string,
  glmMessages: { role: string; content: string }[],
) => {
  let content = "";
  let parentId: string | null = null;
  try {
    parentId = await client.getCurrentMessageId(chatId);
  } catch {
    parentId = null;
  }
  for await (const chunk of client.sendMessage({
    chatId,
    messages: glmMessages,
    includeHistory: false,
    enableThinking: false,
    parentMessageId: parentId,
  })) {
    if (chunk.type === "content") {
      content += chunk.data;
    }
  }
  return content.trim();
};

const openaiToolResponse = (toolCalls: any[], model: string) => ({
  id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: null, tool_calls: toolCalls },
      finish_reason: "tool_calls",
    },
  ],
});

const openaiContentResponse = (content: string, model: string) => ({
  id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
});

const streamContent = (content: string, model: string) => {
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  return [
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
};

const streamToolCalls = (toolCalls: any[], model: string) => {
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  return [
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: "tool_calls" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
};

const sendToolCalls = (reply: FastifyReply, toolCalls: any[], model: string, stream: boolean) => {
  if (stream) {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.raw.write(streamToolCalls(toolCalls, model));
    return reply.raw.end();
  }
  return reply.send(openaiToolResponse(toolCalls, model));
};

app.get("/", async () => ({ status: "ok", message: "GLM proxy is running" }));

app.get("/v1/models", async () => ({
  object: "list",
  data: [
    {
      id: "glm-4.7",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "z.ai",
    },
  ],
}));

app.get("/models", async () => ({
  object: "list",
  data: [
    {
      id: "glm-4.7",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "z.ai",
    },
  ],
}));

const handleChatCompletion = async (request: FastifyRequest, reply: FastifyReply) => {
  const body = request.body as any;
  const model = body.model || "glm-4.7";
  const messages = body.messages || [];
  const tools = body.tools || [];
  const stream = Boolean(body.stream);
  const toolChoice = body.tool_choice;

  if (toolChoice === "none") {
    tools.length = 0;
  }

  const chatId = await ensureChat();

  const lastUser = messages.slice().reverse().find((m: any) => m.role === "user")?.content || "";
  const last = messages[messages.length - 1];
  const hasToolResult = Boolean(last && (last.role === "tool" || last.tool_call_id));
  const toolResultCount = messages.filter((m: any) => m.role === "tool" || m.tool_call_id).length;
  const maxToolLoops = Number(process.env.PROXY_TOOL_LOOP_LIMIT || "3");
  const toolRegistry = buildToolRegistry(tools);
  if (process.env.PROXY_DEBUG) {
    const roles = messages.map((m: any) => m.role).join(",");
    const sys = messages.find((m: any) => m.role === "system")?.content || "";
    console.log("proxy_debug stream:", stream, "tool_choice:", toolChoice);
    console.log("proxy_debug roles:", roles);
    if (sys) {
      console.log("proxy_debug system:", sys.slice(0, 200));
    }
    if (hasToolResult) {
      const toolMsg = messages.slice().reverse().find((m: any) => m.role === "tool");
      const toolPreview = toolMsg?.content
        ? toolMsg.content.slice(0, 200)
        : "";
      console.log("proxy_debug tool_result_preview:", toolPreview);
    }
  }
  const toolChoiceRequired =
    toolChoice === "required" ||
    (toolChoice && typeof toolChoice === "object" && toolChoice.type === "function");

  const inferredToolCall =
    !hasToolResult && tools.length > 0
      ? inferReadToolCall(toolRegistry, lastUser) ||
        inferWriteToolCall(toolRegistry, lastUser) ||
        inferListToolCall(toolRegistry, lastUser)
      : null;

  const shouldAttemptTools =
    tools.length > 0 && (toolChoiceRequired || Boolean(inferredToolCall) || hasToolResult);
  let glmMessages = convertMessages(messages, shouldAttemptTools ? tools : []);
  if (hasToolResult && shouldAttemptTools) {
    glmMessages = [
      {
        role: "system",
        content:
          "Use the tool results to answer the user. If no further tools are needed, return a final response.",
      },
      ...glmMessages,
    ];
  }

  if (shouldAttemptTools) {
    const earlyFallback = inferredToolCall;
    if (process.env.PROXY_DEBUG) {
      console.log("proxy_debug tools:", tools.map((t: any) => t.function?.name || t.name || "tool"));
      console.log("proxy_debug lastUser:", lastUser);
      console.log("proxy_debug earlyFallback:", Boolean(earlyFallback));
    }
    if (earlyFallback) {
      return sendToolCalls(reply, earlyFallback, model, stream);
    }

    let responseText = await collectGlmResponse(chatId, glmMessages);
    if (process.env.PROXY_DEBUG) {
      const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
      console.log("proxy_debug model_raw:", preview);
    }
    let parsed = parseModelOutput(responseText, true);
    if (!parsed.ok) {
      const relaxed = parseModelOutput(responseText, false);
      if (relaxed.ok) {
        parsed = relaxed;
      }
    }
    if (!parsed.ok) {
      // one retry with corrective message
      const corrective = {
        role: "assistant",
        content: "Return ONLY valid JSON following the schema. No extra text.",
      };
      responseText = await collectGlmResponse(chatId, [...glmMessages, corrective]);
      if (process.env.PROXY_DEBUG) {
        const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
        console.log("proxy_debug model_retry_raw:", preview);
      }
      parsed = parseModelOutput(responseText, true);
      if (!parsed.ok) {
        const relaxed = parseModelOutput(responseText, false);
        if (relaxed.ok) {
          parsed = relaxed;
        }
      }
    }

    if (!parsed.ok) {
      const stricter = {
        role: "assistant",
        content: "Return ONLY valid JSON object. No markdown. No extra keys.",
      };
      responseText = await collectGlmResponse(chatId, [...glmMessages, stricter]);
      if (process.env.PROXY_DEBUG) {
        const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
        console.log("proxy_debug model_retry2_raw:", preview);
      }
      parsed = parseModelOutput(responseText, true);
      if (!parsed.ok) {
        const relaxed = parseModelOutput(responseText, false);
        if (relaxed.ok) {
          parsed = relaxed;
        }
      }
    }

    if (!parsed.ok || !parsed.data) {
      const rawToolCalls = parseRawToolCalls(responseText, toolRegistry);
      if (rawToolCalls) {
        return sendToolCalls(reply, rawToolCalls, model, stream);
      }
      if (hasToolResult && responseText.trim()) {
        if (stream) {
          reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
          reply.raw.write(streamContent(responseText, model));
          return reply.raw.end();
        }
        return reply.send(openaiContentResponse(responseText, model));
      }
      const fallbackTools =
        inferReadToolCall(toolRegistry, lastUser) ||
        inferWriteToolCall(toolRegistry, lastUser) ||
        inferListToolCall(toolRegistry, lastUser);
      if (fallbackTools) {
        return sendToolCalls(reply, fallbackTools, model, stream);
      }
      const fallback = openaiContentResponse("Unable to generate tool call.", model);
      if (stream) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent("Unable to generate tool call.", model));
        return reply.raw.end();
      }
      return reply.send(fallback);
    }

    let parsedData = parsed.data;
    if (process.env.PROXY_DEBUG) {
      console.log("proxy_debug parsed_actions:", parsedData.actions.length);
      if (parsedData.actions.length) {
        console.log("proxy_debug action_tools:", parsedData.actions.map((a) => a.tool).join(","));
      }
    }

    if (hasToolResult && parsedData.actions.length > 0 && toolResultCount >= maxToolLoops) {
      const fallbackContent = parsedData.final || "Tool result received.";
      if (stream) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent(fallbackContent, model));
        return reply.raw.end();
      }
      return reply.send(openaiContentResponse(fallbackContent, model));
    }

    if (parsedData.actions.length === 0) {
      if (!hasToolResult) {
        const fallbackTools =
          inferReadToolCall(toolRegistry, lastUser) ||
          inferWriteToolCall(toolRegistry, lastUser) ||
          inferListToolCall(toolRegistry, lastUser);
        if (fallbackTools) {
          return sendToolCalls(reply, fallbackTools, model, stream);
        }
      }
      const content = parsedData.final || "";
      if (stream) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent(content, model));
        return reply.raw.end();
      }
      return reply.send(openaiContentResponse(content, model));
    }

    const invalid = parsedData.actions.find((action) => !findTool(toolRegistry, action.tool));
    if (invalid) {
      const content = `Unknown tool: ${invalid.tool}`;
      if (stream) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent(content, model));
        return reply.raw.end();
      }
      return reply.send(openaiContentResponse(content, model));
    }

    const toolCalls = parsedData.actions.map((action, idx) => {
      const toolInfo = findTool(toolRegistry, action.tool);
      const toolName = toolInfo?.tool.function?.name || toolInfo?.tool.name || action.tool;
      const args = normalizeArgsForTool(toolInfo, action.args || {});
      return {
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        index: idx,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
      };
    });

    return sendToolCalls(reply, toolCalls, model, stream);
  }

  if (stream) {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    let parentId: string | null = null;
    try {
      parentId = await client.getCurrentMessageId(chatId);
    } catch {
      parentId = null;
    }
    const generator = client.sendMessage({
      chatId,
      messages: glmMessages,
      includeHistory: false,
      enableThinking: false,
      parentMessageId: parentId,
    });
    const streamId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
    const created = Math.floor(Date.now() / 1000);
    let sentRole = false;
    for await (const chunk of generator) {
      if (chunk.type !== "content") continue;
      const payload = {
        id: streamId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: sentRole ? { content: chunk.data } : { role: "assistant", content: chunk.data },
            finish_reason: null,
          },
        ],
      };
      sentRole = true;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
    const finalPayload = {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    reply.raw.write(`data: ${JSON.stringify(finalPayload)}\n\n`);
    reply.raw.write("data: [DONE]\n\n");
    return reply.raw.end();
  }

  const content = await collectGlmResponse(chatId, glmMessages);
  return reply.send(openaiContentResponse(content, model));
};

app.post("/v1/chat/completions", handleChatCompletion);
app.post("/chat/completions", handleChatCompletion);

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

app.listen({ port, host }).then(() => {
  console.log(`GLM proxy listening on http://${host}:${port}`);
});

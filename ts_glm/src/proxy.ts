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

const findTool = (tools: any[], name: string) => {
  const target = normalizeToolName(name);
  return tools.find((t) => {
    const fn = t.function || {};
    const names: string[] = [];
    if (fn.name) names.push(fn.name);
    if (fn.tool?.name) names.push(fn.tool.name);
    if (t.name) names.push(t.name);
    return names.some((n) => isNameMatch(target, normalizeToolName(n)));
  });
};

const pickArgKey = (tool: any, candidates: string[]): string => {
  const props =
    tool?.function?.parameters?.properties ||
    tool?.parameters?.properties ||
    tool?.function?.tool?.parameters?.properties ||
    {};
  for (const key of candidates) {
    if (key in props) return key;
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

const inferReadToolCall = (tools: any[], userText: string) => {
  const lowered = userText.toLowerCase();
  const readIntent = ["read", "open", "show", "cat", "contents", "what is in", "what's in", "display"];
  const path = extractFilePath(userText);
  const hasReadIntent = readIntent.some((k) => lowered.includes(k));
  if (!hasReadIntent && !looksLikePath(path)) return null;
  const tool = findTool(tools, "read") || findTool(tools, "read_file");
  if (!tool) return null;
  if (!path) return null;
  const key = pickArgKey(tool, ["filePath", "path"]);
  const toolName = tool.function?.name || tool.name || "read";
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify({ [key]: path }) },
    },
  ];
};

const inferWriteToolCall = (tools: any[], userText: string) => {
  const tool = findTool(tools, "write") || findTool(tools, "write_file");
  if (!tool) return null;
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
    const pathKey = pickArgKey(tool, ["filePath", "path"]);
  const toolName = tool.function?.name || tool.name || "write";
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
    const pathKey = pickArgKey(tool, ["filePath", "path"]);
    const toolName = tool.function?.name || tool.name || "write";
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

const inferListToolCall = (tools: any[], userText: string) => {
  const lowered = userText.toLowerCase();
  const listIntent = ["list files", "list folders", "list directory", "ls", "show files", "inspect files"];
  if (!listIntent.some((k) => lowered.includes(k))) return null;
  const tool = findTool(tools, "glob") || findTool(tools, "list") || findTool(tools, "list_dir");
  if (!tool) return null;
  const key = pickArgKey(tool, ["pattern", "path"]);
  const args = key === "pattern" ? { [key]: "**/*" } : { [key]: "." };
  return [
    {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: 0,
      type: "function",
      function: { name: tool.function?.name || tool.name || "glob", arguments: JSON.stringify(args) },
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
      out.push({ role: "user", content: `Tool result (${msg.name || "tool"}):\n${msg.content || ""}` });
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
      ? inferReadToolCall(tools, lastUser) ||
        inferWriteToolCall(tools, lastUser) ||
        inferListToolCall(tools, lastUser)
      : null;

  const shouldAttemptTools =
    tools.length > 0 && (toolChoiceRequired || Boolean(inferredToolCall) || hasToolResult);
  const glmMessages = convertMessages(messages, shouldAttemptTools ? tools : []);

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

    if (!parsed.ok || !parsed.data) {
      const fallbackTools =
        inferReadToolCall(tools, lastUser) ||
        inferWriteToolCall(tools, lastUser) ||
        inferListToolCall(tools, lastUser);
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

    if (hasToolResult && parsedData.actions.length > 0) {
      const forceFinal: any = {
        role: "assistant",
        content: "Tool results are already provided. Return ONLY valid JSON with actions: [] and a final response. Do not call tools.",
      };
      let finalText = await collectGlmResponse(chatId, [...glmMessages, forceFinal]);
      if (process.env.PROXY_DEBUG) {
        const preview = finalText.length > 400 ? `${finalText.slice(0, 400)}…` : finalText;
        console.log("proxy_debug model_post_tool_raw:", preview);
      }
      let finalParsed = parseModelOutput(finalText, true);
      if (!finalParsed.ok) {
        const relaxed = parseModelOutput(finalText, false);
        if (relaxed.ok) {
          finalParsed = relaxed;
        }
      }
      if (finalParsed.ok && finalParsed.data && finalParsed.data.actions.length === 0) {
        parsed = finalParsed;
        parsedData = finalParsed.data;
      } else {
        const fallbackContent = "Tool result received.";
        if (stream) {
          reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
          reply.raw.write(streamContent(fallbackContent, model));
          return reply.raw.end();
        }
        return reply.send(openaiContentResponse(fallbackContent, model));
      }
    }

    if (parsedData.actions.length === 0) {
      if (!hasToolResult) {
        const fallbackTools =
          inferReadToolCall(tools, lastUser) ||
          inferWriteToolCall(tools, lastUser) ||
          inferListToolCall(tools, lastUser);
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

    const allowed = new Set(tools.map((t: any) => t.function?.name).filter(Boolean));
    const invalid = parsedData.actions.find((action) => !allowed.has(action.tool));
    if (invalid) {
      const content = `Unknown tool: ${invalid.tool}`;
      if (stream) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent(content, model));
        return reply.raw.end();
      }
      return reply.send(openaiContentResponse(content, model));
    }

    const toolCalls = parsedData.actions.map((action, idx) => ({
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      index: idx,
      type: "function",
      function: {
        name: action.tool,
        arguments: JSON.stringify(action.args || {}),
      },
    }));

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
    let sentRole = false;
    for await (const chunk of generator) {
      if (chunk.type !== "content") continue;
      const payload = {
        id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
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
      id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
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

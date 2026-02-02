import crypto from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { GLMClient } from "../glmClient.js";
import {
  ACTIONABLE_KEYWORDS,
  DEFAULT_MODEL,
  EMBEDDED_READ_REGEX,
  FILE_MENTION_REGEX,
  PLANNER_JSON_HINT_REGEX,
  PROXY_ALLOW_WEB_SEARCH,
  PROXY_DEBUG,
  PROXY_TOOL_LOOP_LIMIT,
  READ_LIKE_WITH_FILE_REGEX,
  REPO_STRUCTURE_PATTERNS,
} from "./constants.js";
import { collectGlmResponse, convertMessages, stripDirectivesFromContent } from "./messages.js";
import { openaiContentResponse, openaiToolResponse, sendToolCalls, streamContent } from "./openai.js";
import {
  inferApplyPatchToolCall,
  inferEditToolCall,
  inferExplicitToolCalls,
  inferListToolCall,
  inferReadToolCall,
  inferRunToolCall,
  inferWriteToolCall,
} from "./tools/infer.js";
import { buildToolRegistry, findTool, normalizeArgsForTool } from "./tools/registry.js";
import { parseRawToolCalls, tryParseModelOutput, tryRepairPlannerOutput } from "./tools/parse.js";

type ChatCompletionHandlerDeps = {
  client: GLMClient;
  ensureChat: () => Promise<string>;
};

const createChatCompletionHandler = ({ client, ensureChat }: ChatCompletionHandlerDeps) => {
  const handleChatCompletion = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const model = body.model || DEFAULT_MODEL;
    const messages = body.messages || [];
    const tools = body.tools || [];
    const stream = Boolean(body.stream);
    const toolChoice = body.tool_choice;

    if (toolChoice === "none") {
      tools.length = 0;
    }

    const chatId = await ensureChat();

    const lastUserIndex = (() => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === "user") return i;
      }
      return -1;
    })();
    const lastUserContent = lastUserIndex >= 0 ? messages[lastUserIndex].content : "";
    const directiveResult = stripDirectivesFromContent(lastUserContent);
    const lastUser = directiveResult.cleanedText || "";
    const sanitizedMessages =
      lastUserIndex >= 0 && directiveResult.content !== lastUserContent
        ? messages.map((msg: any, idx: number) =>
            idx === lastUserIndex ? { ...msg, content: directiveResult.content } : msg
          )
        : messages;
    const last = messages[messages.length - 1];
    const hasToolResult = Boolean(last && (last.role === "tool" || last.tool_call_id));
    const toolResultCount = messages.filter((m: any) => m.role === "tool" || m.tool_call_id).length;
    const maxToolLoops = PROXY_TOOL_LOOP_LIMIT;
    const toolRegistry = buildToolRegistry(tools);
    const bodyFeatures = body?.features && typeof body.features === "object" ? body.features : {};
    const featureOverrides: Record<string, unknown> = { ...bodyFeatures };
    const allowWebSearch = PROXY_ALLOW_WEB_SEARCH;
    const userRequestedWebSearch =
      typeof directiveResult.overrides.web_search === "boolean"
        ? directiveResult.overrides.web_search
        : typeof body?.web_search === "boolean"
          ? body.web_search
          : typeof (bodyFeatures as { web_search?: unknown }).web_search === "boolean"
            ? (bodyFeatures as { web_search: boolean }).web_search
            : false;
    const enableThinking =
      typeof body?.enable_thinking === "boolean"
        ? body.enable_thinking
        : typeof body?.enableThinking === "boolean"
          ? body.enableThinking
          : typeof (bodyFeatures as { enable_thinking?: unknown }).enable_thinking === "boolean"
            ? (bodyFeatures as { enable_thinking: boolean }).enable_thinking
            : typeof (bodyFeatures as { enableThinking?: unknown }).enableThinking === "boolean"
              ? (bodyFeatures as { enableThinking: boolean }).enableThinking
              : true;
    if (typeof directiveResult.overrides.enable_thinking === "boolean") {
      featureOverrides.enable_thinking = directiveResult.overrides.enable_thinking;
    }
    if (typeof directiveResult.overrides.web_search === "boolean") {
      featureOverrides.web_search = directiveResult.overrides.web_search;
      if (featureOverrides.web_search === true && featureOverrides.auto_web_search === undefined) {
        featureOverrides.auto_web_search = true;
      }
    }
    if (typeof directiveResult.overrides.auto_web_search === "boolean") {
      featureOverrides.auto_web_search = directiveResult.overrides.auto_web_search;
    }
    const enableThinkingFinal =
      typeof featureOverrides.enable_thinking === "boolean"
        ? (featureOverrides.enable_thinking as boolean)
        : enableThinking;
    if (typeof body?.web_search === "boolean") {
      featureOverrides.web_search = body.web_search;
      if (featureOverrides.web_search === true && featureOverrides.auto_web_search === undefined) {
        featureOverrides.auto_web_search = true;
      }
    }
    if (typeof body?.auto_web_search === "boolean") {
      featureOverrides.auto_web_search = body.auto_web_search;
    }
    if (!allowWebSearch) {
      featureOverrides.web_search = false;
      featureOverrides.auto_web_search = false;
    } else if (featureOverrides.web_search === true && featureOverrides.auto_web_search === undefined) {
      featureOverrides.auto_web_search = true;
    }
    const loweredUser = lastUser.toLowerCase();
    const hasEmbeddedRead = EMBEDDED_READ_REGEX.test(lastUser);
    const fileMention = FILE_MENTION_REGEX.test(lastUser);
    const repoStructureIntent = REPO_STRUCTURE_PATTERNS.some((pattern) => pattern.test(loweredUser));
    const readLikeWithFile = READ_LIKE_WITH_FILE_REGEX.test(loweredUser);
    let actionable =
      ACTIONABLE_KEYWORDS.some((k) => loweredUser.includes(k)) ||
      repoStructureIntent ||
      (fileMention && readLikeWithFile);
    if (hasEmbeddedRead) {
      actionable = false;
    }
    if (PROXY_DEBUG) {
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

    const allowHeuristicTools = !hasEmbeddedRead;
    const explicitToolCalls =
      allowHeuristicTools && !hasToolResult && tools.length > 0
        ? inferExplicitToolCalls(toolRegistry, lastUser)
        : null;
    const inferredToolCall =
      allowHeuristicTools && !hasToolResult && tools.length > 0
        ? inferApplyPatchToolCall(toolRegistry, lastUser) ||
          inferEditToolCall(toolRegistry, lastUser) ||
          inferReadToolCall(toolRegistry, lastUser) ||
          inferWriteToolCall(toolRegistry, lastUser) ||
          inferRunToolCall(toolRegistry, lastUser) ||
          inferListToolCall(toolRegistry, lastUser)
        : null;

    const shouldAttemptTools =
      tools.length > 0 &&
      (toolChoiceRequired ||
        Boolean(explicitToolCalls) ||
        Boolean(inferredToolCall) ||
        hasToolResult ||
        actionable);
    let glmMessages = convertMessages(sanitizedMessages, shouldAttemptTools ? tools : []);
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
      const earlyFallback = explicitToolCalls || inferredToolCall;
      if (PROXY_DEBUG) {
        console.log("proxy_debug tools:", tools.map((t: any) => t.function?.name || t.name || "tool"));
        console.log("proxy_debug lastUser:", lastUser);
        console.log("proxy_debug earlyFallback:", Boolean(earlyFallback));
      }
      if (earlyFallback) {
        return sendToolCalls(reply, earlyFallback, model, stream);
      }

      let responseText = await collectGlmResponse(client, chatId, glmMessages, {
        enableThinking: enableThinkingFinal,
        features: featureOverrides,
      });
      const initialResponseText = responseText;
      if (PROXY_DEBUG) {
        const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
        console.log("proxy_debug model_raw:", preview);
      }
      let parsed = tryParseModelOutput(responseText, false);
      if (!parsed.ok) {
        // one retry with corrective message
        const corrective = {
          role: "assistant",
          content: "Return ONLY valid JSON following the schema. No extra text.",
        };
        responseText = await collectGlmResponse(client, chatId, [...glmMessages, corrective], {
          enableThinking: enableThinkingFinal,
          features: featureOverrides,
        });
        if (PROXY_DEBUG) {
          const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
          console.log("proxy_debug model_retry_raw:", preview);
        }
        parsed = tryParseModelOutput(responseText, false);
      }

      if (!parsed.ok) {
        const stricter = {
          role: "assistant",
          content: "Return ONLY valid JSON object. No markdown. No extra keys.",
        };
        responseText = await collectGlmResponse(client, chatId, [...glmMessages, stricter], {
          enableThinking: enableThinkingFinal,
          features: featureOverrides,
        });
        if (PROXY_DEBUG) {
          const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}…` : responseText;
          console.log("proxy_debug model_retry2_raw:", preview);
        }
        parsed = tryParseModelOutput(responseText, false);
      }

      if (!parsed.ok) {
        parsed = tryParseModelOutput(responseText, true);
        if (!parsed.ok && responseText !== initialResponseText) {
          parsed = tryParseModelOutput(initialResponseText, true);
        }
      }

      if (!parsed.ok || !parsed.data) {
        const repaired = tryRepairPlannerOutput(responseText);
        if (repaired) {
          parsed = { ok: true, data: repaired };
        }
      }

      if (!parsed.ok || !parsed.data) {
        const rawToolCalls = parseRawToolCalls(responseText, toolRegistry);
        if (rawToolCalls) {
          return sendToolCalls(reply, rawToolCalls, model, stream);
        }
        if (hasToolResult) {
          const looksLikePlannerJson = PLANNER_JSON_HINT_REGEX.test(responseText) || responseText.trim().startsWith("{");
          if (looksLikePlannerJson) {
            const finalMessages = [
              {
                role: "system",
                content: "Use the tool results above to answer the user. Return plain text only and do not call tools.",
              },
              ...convertMessages(messages, []),
            ];
            const finalText = await collectGlmResponse(client, chatId, finalMessages, {
              enableThinking: enableThinkingFinal,
              features: featureOverrides,
            });
            if (stream) {
              reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
              reply.raw.write(streamContent(finalText, model));
              return reply.raw.end();
            }
            return reply.send(openaiContentResponse(finalText, model));
          }
        }
        if (hasToolResult && responseText.trim()) {
          if (stream) {
            reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
            reply.raw.write(streamContent(responseText, model));
            return reply.raw.end();
          }
          return reply.send(openaiContentResponse(responseText, model));
        }
        const fallbackTools = allowHeuristicTools
          ? inferApplyPatchToolCall(toolRegistry, lastUser) ||
            inferEditToolCall(toolRegistry, lastUser) ||
            inferReadToolCall(toolRegistry, lastUser) ||
            inferWriteToolCall(toolRegistry, lastUser) ||
            inferRunToolCall(toolRegistry, lastUser) ||
            inferListToolCall(toolRegistry, lastUser)
          : null;
        if (fallbackTools) {
          return sendToolCalls(reply, fallbackTools, model, stream);
        }
        if (!toolChoiceRequired) {
          const finalMessages = [
            {
              role: "system",
              content: "Answer the user directly. Return plain text only and do not call tools.",
            },
            ...convertMessages(messages, []),
          ];
          const finalText = await collectGlmResponse(client, chatId, finalMessages, {
            enableThinking: enableThinkingFinal,
            features: featureOverrides,
          });
          if (stream) {
            reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
            reply.raw.write(streamContent(finalText, model));
            return reply.raw.end();
          }
          return reply.send(openaiContentResponse(finalText, model));
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
      if (PROXY_DEBUG) {
        console.log("proxy_debug parsed_actions:", parsedData.actions.length);
        if (parsedData.actions.length) {
          console.log("proxy_debug action_tools:", parsedData.actions.map((a) => a.tool).join(","));
        }
      }

    if (hasToolResult && parsedData.actions.length > 0 && toolResultCount >= maxToolLoops) {
      const finalMessages = [
        {
          role: "system",
          content:
            "Tool loop limit reached. Use the tool results above to answer the user. Return plain text only and do not call tools.",
        },
        ...convertMessages(messages, []),
      ];
      const finalText = await collectGlmResponse(client, chatId, finalMessages, {
        enableThinking: enableThinkingFinal,
        features: featureOverrides,
      });
      if (stream) {
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent(finalText, model));
        return reply.raw.end();
      }
      return reply.send(openaiContentResponse(finalText, model));
    }

      if (parsedData.actions.length === 0) {
        if (!hasToolResult) {
          const fallbackTools = allowHeuristicTools
            ? inferApplyPatchToolCall(toolRegistry, lastUser) ||
              inferEditToolCall(toolRegistry, lastUser) ||
              inferReadToolCall(toolRegistry, lastUser) ||
              inferWriteToolCall(toolRegistry, lastUser) ||
              inferRunToolCall(toolRegistry, lastUser) ||
              inferListToolCall(toolRegistry, lastUser)
            : null;
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
      if (tools.length > 0 && !shouldAttemptTools) {
        const fullText = await collectGlmResponse(client, chatId, glmMessages, {
          enableThinking: enableThinkingFinal,
          features: featureOverrides,
        });
        const rawToolCalls = parseRawToolCalls(fullText, toolRegistry);
        if (rawToolCalls) {
          return sendToolCalls(reply, rawToolCalls, model, true);
        }
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
        reply.raw.write(streamContent(fullText, model));
        return reply.raw.end();
      }
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
        enableThinking: enableThinkingFinal,
        features: featureOverrides,
        parentMessageId: parentId,
      });
      const streamId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
      const created = Math.floor(Date.now() / 1000);
      let sentRole = false;
      for await (const chunk of generator) {
        if (chunk.type === "thinking") {
          const payload = {
            id: streamId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { reasoning_content: chunk.data }, finish_reason: null }],
          };
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
          continue;
        }

        if (chunk.type === "thinking_end") {
          continue;
        }

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

    const content = await collectGlmResponse(client, chatId, glmMessages, {
      enableThinking: enableThinkingFinal,
      features: featureOverrides,
    });
    if (tools.length > 0) {
      const rawToolCalls = parseRawToolCalls(content, toolRegistry);
      if (rawToolCalls) {
        return reply.send(openaiToolResponse(rawToolCalls, model));
      }
    }
    return reply.send(openaiContentResponse(content, model));
  };

  return handleChatCompletion;
};

export { createChatCompletionHandler };

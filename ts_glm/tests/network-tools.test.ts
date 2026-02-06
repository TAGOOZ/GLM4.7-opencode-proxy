import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { PROXY_ALLOW_WEB_SEARCH } from "../src/proxy/constants.js";
import { createChatCompletionHandler } from "../src/proxy/handler.js";

test("proxy gates webfetch/web_search tools behind PROXY_ALLOW_WEB_SEARCH", async () => {
  const captured: any[] = [];
  const client: any = {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage(options: any) {
      captured.push(options.messages);
      const planner = {
        plan: ["fetch"],
        actions: [
          { tool: "webfetch", args: { url: "https://example.com", format: "text" } },
        ],
        final: "",
      };
      yield { type: "content", data: JSON.stringify(planner) };
    },
  };

  const app = Fastify();
  try {
    const handler = createChatCompletionHandler({
      client,
      ensureChat: async () => "chat_test",
      resetChat: () => {},
    });
    app.post("/v1/chat/completions", handler);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "glm-4.7",
        stream: false,
        messages: [{ role: "user", content: "fetch https://example.com" }],
        tools: [
          {
            function: {
              name: "read",
              parameters: { properties: { path: { type: "string" } } },
            },
          },
          {
            function: {
              name: "webfetch",
              parameters: { properties: { url: { type: "string" }, format: { type: "string" } } },
            },
          },
          {
            function: {
              name: "web_search",
              parameters: { properties: { query: { type: "string" } } },
            },
          },
        ],
      },
    });

    assert.equal(res.statusCode, 200);

    const data = res.json() as any;
    const system = String(captured[0]?.find((msg: any) => msg.role === "system")?.content || "").toLowerCase();

    if (PROXY_ALLOW_WEB_SEARCH) {
      assert.ok(system.includes("webfetch"));
      assert.ok(system.includes("web_search"));
      const toolCalls = data?.choices?.[0]?.message?.tool_calls;
      assert.ok(Array.isArray(toolCalls));
      assert.equal(toolCalls?.[0]?.function?.name, "webfetch");
    } else {
      assert.ok(!system.includes("webfetch"));
      assert.ok(!system.includes("web_search"));
      const content = data?.choices?.[0]?.message?.content;
      assert.equal(typeof content, "string");
      assert.ok(content.includes("Blocked unsafe tool call"));
      assert.ok(content.includes("web_tools_disabled"));
    }
  } finally {
    await app.close();
  }
});


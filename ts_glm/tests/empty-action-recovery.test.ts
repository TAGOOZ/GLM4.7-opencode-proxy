import test from "node:test";
import assert from "node:assert/strict";

import { createChatCompletionHandler } from "../src/proxy/handler.js";

const makeReply = () => {
  const sent: { payload?: any } = {};
  const reply = {
    header() {
      // ignore
    },
    send(payload: any) {
      sent.payload = payload;
      return payload;
    },
    raw: {
      writeHead() {
        // ignore
      },
      write() {
        // ignore
      },
      end() {
        // ignore
      },
    },
  } as any;
  return { reply, sent };
};

test("proxy retries once when tool-result turn returns empty actions and empty final", async () => {
  let sendCalls = 0;
  const client: any = {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage() {
      sendCalls++;
      if (sendCalls === 1) {
        yield {
          type: "content",
          data: JSON.stringify({
            plan: ["continue"],
            actions: [],
            final: "",
          }),
        };
        return;
      }
      yield {
        type: "content",
        data: JSON.stringify({
          plan: ["run command"],
          actions: [{ tool: "bash", args: { command: "echo ok" } }],
          final: "",
        }),
      };
    },
  };

  const handler = createChatCompletionHandler({
    client,
    ensureChat: async () => "chat_recover_empty",
    resetChat: () => {},
  });

  const { reply, sent } = makeReply();
  const request = {
    body: {
      model: "glm-4.7",
      stream: false,
      tools: [
        {
          function: {
            name: "bash",
            parameters: {
              properties: {
                command: { type: "string" },
                description: { type: "string" },
              },
            },
          },
        },
      ],
      messages: [
        { role: "user", content: "snake game in rust in isolated folder" },
        { role: "assistant", content: "[{\"id\":\"call_1\",\"type\":\"function\"}]" },
        { role: "tool", tool_call_id: "call_1", content: "mkdir done" },
      ],
    },
  } as any;

  await handler(request, reply);

  assert.equal(sendCalls, 2);
  const toolCalls = sent.payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls[0]?.function?.name, "bash");
});


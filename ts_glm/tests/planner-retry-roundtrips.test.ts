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

test("planner retry reuses parentMessageId (avoids repeated getCurrentMessageId round trips)", async () => {
  let sendCalls = 0;
  let currentCalls = 0;

  const client: any = {
    async getCurrentMessageId() {
      currentCalls++;
      return "parent_1";
    },
    async *sendMessage() {
      sendCalls++;
      if (sendCalls === 1) {
        yield { type: "content", data: "not json" };
        return;
      }
      yield {
        type: "content",
        data: JSON.stringify({ plan: ["answer directly"], actions: [], final: "ok" }),
      };
    },
  };

  const handler = createChatCompletionHandler({
    client,
    ensureChat: async () => "chat_1",
    resetChat: () => {},
  });

  const { reply } = makeReply();
  const request = {
    body: {
      model: "glm-4.7",
      stream: false,
      tools: [
        {
          function: {
            name: "read",
            parameters: { properties: { path: { type: "string" } } },
          },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    },
  } as any;

  await handler(request, reply);

  assert.equal(sendCalls, 2, "expected one retry");
  assert.equal(currentCalls, 1, "expected parentMessageId resolved once for all attempts");
});


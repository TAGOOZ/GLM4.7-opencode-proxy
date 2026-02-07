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

test("pending confirmation accepts OpenCode 'Proceed (Recommended)' answer text", async () => {
  const client: any = {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage() {
      yield {
        type: "content",
        data: JSON.stringify({
          plan: ["run bash command"],
          actions: [{ tool: "bash", args: { command: "rm -rf tmp" } }],
          final: "",
        }),
      };
    },
  };

  const handler = createChatCompletionHandler({
    client,
    ensureChat: async () => "chat_1",
    resetChat: () => {},
  });

  const tools = [
    {
      function: {
        name: "bash",
        parameters: { properties: { command: { type: "string" }, description: { type: "string" } } },
      },
    },
    {
      function: {
        name: "question",
        parameters: { properties: { questions: { type: "array" } } },
      },
    },
  ];

  const first = makeReply();
  await handler(
    {
      body: {
        model: "glm-4.7",
        stream: false,
        tools,
        messages: [{ role: "user", content: "update it" }],
      },
    } as any,
    first.reply,
  );

  const confirmationCall = first.sent.payload?.choices?.[0]?.message?.tool_calls?.[0];
  assert.ok(confirmationCall);
  assert.equal(confirmationCall?.function?.name, "question");
  const confirmationId = String(confirmationCall?.id || "");
  assert.equal(Boolean(confirmationId), true);

  const second = makeReply();
  await handler(
    {
      body: {
        model: "glm-4.7",
        stream: false,
        tools,
        messages: [
          { role: "user", content: "update it" },
          {
            role: "tool",
            tool_call_id: confirmationId,
            content:
              'User has answered your questions: "Confirm override"="Proceed (Recommended)". You can now continue with the user\'s answers in mind.',
          },
        ],
      },
    } as any,
    second.reply,
  );

  const replayedCall = second.sent.payload?.choices?.[0]?.message?.tool_calls?.[0];
  assert.ok(replayedCall);
  assert.equal(replayedCall?.function?.name, "bash");
});

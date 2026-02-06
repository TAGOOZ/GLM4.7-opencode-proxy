import test from "node:test";
import assert from "node:assert/strict";
import { openaiToolResponse, streamToolCalls } from "../src/proxy/openai.js";

const parseSseEvents = (sse: string): string[] => {
  return sse
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.replace(/^data:\s*/i, ""));
};

test("streamToolCalls emits OpenAI-compatible tool_calls stream shape", () => {
  const toolCalls = [
    {
      index: 0,
      id: "call_123",
      type: "function",
      function: { name: "read", arguments: "{\"path\":\"README.md\"}" },
    },
  ];
  const sse = streamToolCalls(toolCalls, "glm-4.7");
  const events = parseSseEvents(sse);
  assert.ok(events.length >= 3);
  assert.strictEqual(events.at(-1), "[DONE]");

  const first = JSON.parse(events[0] as string);
  assert.strictEqual(first.object, "chat.completion.chunk");
  assert.strictEqual(first.choices?.[0]?.delta?.role, "assistant");
  assert.ok(Array.isArray(first.choices?.[0]?.delta?.tool_calls));
  assert.strictEqual(first.choices?.[0]?.finish_reason, null);

  const second = JSON.parse(events[1] as string);
  assert.strictEqual(second.object, "chat.completion.chunk");
  assert.deepStrictEqual(second.choices?.[0]?.delta, {});
  assert.strictEqual(second.choices?.[0]?.finish_reason, "tool_calls");
});

test("openaiToolResponse strips non-standard index field from non-stream tool_calls", () => {
  const toolCalls = [
    {
      index: 0,
      id: "call_123",
      type: "function",
      function: { name: "read", arguments: "{\"path\":\"README.md\"}" },
      extra: "x",
    },
  ];
  const resp = openaiToolResponse(toolCalls, "glm-4.7");
  const msgCalls = resp.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(msgCalls));
  assert.strictEqual(msgCalls.length, 1);
  assert.equal("index" in msgCalls[0], false);
  assert.equal("extra" in msgCalls[0], false);
  assert.strictEqual(msgCalls[0].id, "call_123");
  assert.strictEqual(msgCalls[0].type, "function");
  assert.strictEqual(msgCalls[0].function?.name, "read");
});


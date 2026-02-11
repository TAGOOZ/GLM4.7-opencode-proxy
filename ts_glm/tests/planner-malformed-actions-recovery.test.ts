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

test("planner malformed fenced JSON still recovers actionable tool calls", async () => {
  const malformedPlanner = [
    "```json",
    "{",
    '  "plan": ["Create snake project"],',
    '  "actions": [',
    "    {",
    '      "tool": "mkdir",',
    '      "args": { "path": "snake_game" },',
    '      "why": "",',
    '      "expect": "",',
    '      "safety": { "risk": "low", "notes": "" }',
    "    },",
    "    {",
    '      "tool": "run",',
    '      "args": { "cmd": "cargo init --name snake_game", "workdir": "snake_game" },',
    '      "why": "",',
    '      "expect": "",',
    '      "safety": { "risk": "low", "notes": "" }',
    "    },",
    "    {",
    '      "tool": "write",',
    '      "args": { "path": "snake_game/src/main.rs", "content": "fn main() { println!("broken"); }" },',
    '      "why": "",',
    '      "expect": "",',
    '      "safety": { "risk": "low", "notes": "" }',
    "    }",
    "  ]",
    "}",
    "```",
  ].join("\n");

  const client = {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage() {
      yield { type: "content", data: malformedPlanner };
    },
  } as any;

  const handler = createChatCompletionHandler({
    client,
    ensureChat: async () => "chat_recovery",
    resetChat: () => {},
  });

  const { reply, sent } = makeReply();
  const request = {
    body: {
      model: "glm-4.7",
      stream: false,
      tools: [
        { function: { name: "mkdir", parameters: { type: "object", properties: { path: { type: "string" } } } } },
        {
          function: {
            name: "run",
            parameters: { type: "object", properties: { cmd: { type: "string" }, workdir: { type: "string" } } },
          },
        },
        {
          function: {
            name: "write",
            parameters: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" } },
            },
          },
        },
      ],
      messages: [{ role: "user", content: "Create snake game project" }],
    },
  } as any;

  await handler(request, reply);

  const toolCalls = sent.payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.ok(toolCalls.length > 0);
  assert.equal(toolCalls[0]?.function?.name, "mkdir");
});

test("planner drops unknown actions and keeps executable known actions", async () => {
  const plannerResponse = JSON.stringify({
    plan: ["inspect project"],
    actions: [
      {
        tool: "unknown_tool_name",
        args: {},
        why: "",
        expect: "",
        safety: { risk: "low", notes: "" },
      },
      {
        tool: "read",
        args: { path: "README.md" },
        why: "",
        expect: "",
        safety: { risk: "low", notes: "" },
      },
    ],
  });

  const client = {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage() {
      yield { type: "content", data: plannerResponse };
    },
  } as any;

  const handler = createChatCompletionHandler({
    client,
    ensureChat: async () => "chat_recovery2",
    resetChat: () => {},
  });

  const { reply, sent } = makeReply();
  const request = {
    body: {
      model: "glm-4.7",
      stream: false,
      tools: [
        { function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
      ],
      messages: [{ role: "user", content: "Read README" }],
    },
  } as any;

  await handler(request, reply);

  const content = sent.payload?.choices?.[0]?.message?.content || "";
  assert.equal(String(content).includes("Unknown tool:"), false);
  const toolCalls = sent.payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.function?.name, "read");
});

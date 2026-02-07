import test from "node:test";
import assert from "node:assert/strict";

import { createChatCompletionHandler } from "../src/proxy/handler.js";
import {
  filterPlannerActions,
  filterPlannerTools,
  shouldAllowTodoTools,
} from "../src/proxy/tools/policy.js";

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

test("policy drops todo tools and actions unless user explicitly asks for checklist/todo", () => {
  assert.equal(shouldAllowTodoTools("build snake game"), false);
  assert.equal(shouldAllowTodoTools("create a todo checklist for this task"), true);

  const tools = [
    { function: { name: "todowrite" } },
    { function: { name: "todoread" } },
    { function: { name: "bash" } },
  ] as any[];
  const toolFiltered = filterPlannerTools(tools, { allowTodoTools: false });
  assert.deepEqual(
    toolFiltered.tools.map((tool: any) => tool.function?.name),
    ["bash"],
  );

  const actionFiltered = filterPlannerActions(
    [
      { tool: "todowrite", args: {} },
      { tool: "bash", args: { command: "echo ok" } },
      { tool: "todoread", args: {} },
    ],
    { allowTodoTools: false },
  );
  assert.deepEqual(actionFiltered.actions.map((action: any) => action.tool), ["bash"]);
  assert.equal(actionFiltered.droppedTodoActions, 2);
});

test("handler strips todo-only planner actions when todo intent is absent and continues with executable action", async () => {
  let sendCalls = 0;
  const client: any = {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage() {
      sendCalls += 1;
      yield {
        type: "content",
        data: JSON.stringify({
          plan: ["set tasks", "initialize project"],
          actions: [
            {
              tool: "todowrite",
              args: { todos: [{ content: "draft tasks" }] },
              why: "track progress",
              expect: "todo list",
              safety: { risk: "low", notes: "" },
            },
            {
              tool: "bash",
              args: { command: "echo init" },
              why: "initialize workspace",
              expect: "command output",
              safety: { risk: "low", notes: "" },
            },
          ],
        }),
      };
    },
  };

  const handler = createChatCompletionHandler({
    client,
    ensureChat: async () => "chat_policy",
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
            name: "todowrite",
            parameters: {
              properties: {
                todos: { type: "array" },
              },
            },
          },
        },
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
      messages: [{ role: "user", content: "create snake game in rust in isolated folder" }],
    },
  } as any;

  await handler(request, reply);

  assert.equal(sendCalls, 1);
  const toolCalls = sent.payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.function?.name, "bash");
});

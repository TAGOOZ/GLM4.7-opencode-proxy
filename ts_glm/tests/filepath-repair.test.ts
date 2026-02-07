import test from "node:test";
import assert from "node:assert/strict";

const makeClient = (content: string) => {
  return {
    async getCurrentMessageId() {
      return null;
    },
    async *sendMessage() {
      yield { type: "content", data: content };
    },
  } as any;
};

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

const TOOLS = [
  {
    function: {
      name: "read",
      parameters: { properties: { path: { type: "string" } } },
    },
  },
  {
    function: {
      name: "write",
      parameters: { properties: { path: { type: "string" }, content: { type: "string" } } },
    },
  },
] as any[];

const runProxy = async (glmResponseText: string, messages: any[]) => {
  process.env.PROXY_STRIP_HISTORY = "0";
  const { createChatCompletionHandler } = await import("../src/proxy/handler.js");
  const handler = createChatCompletionHandler({
    client: makeClient(glmResponseText),
    ensureChat: async () => "chat_1",
    resetChat: () => {},
  });
  const { reply, sent } = makeReply();
  const request = {
    body: {
      model: "glm-4.7",
      stream: false,
      tools: TOOLS,
      messages,
    },
  } as any;
  await handler(request, reply);
  return sent.payload;
};

test("planner read without path is repaired from recent conversation", async () => {
  const payload = await runProxy(
    JSON.stringify({
      plan: ["read the file"],
      actions: [{ tool: "read", args: {} }],
    }),
    [
      { role: "assistant", content: "Created calculator in calculator/calculator.py and README.md." },
      { role: "user", content: "open it" },
    ],
  );
  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 1);
  const args = JSON.parse(toolCalls[0]?.function?.arguments || "{}");
  assert.equal(args.path, "calculator/calculator.py");
});

test("planner write without path is blocked", async () => {
  const payload = await runProxy(
    JSON.stringify({
      plan: ["write a quick note"],
      actions: [{ tool: "write", args: { content: "hi" } }],
    }),
    [
      { role: "assistant", content: "Created calculator in calculator/calculator.py and README.md." },
      { role: "user", content: "please update it" },
    ],
  );

  const content = payload?.choices?.[0]?.message?.content || "";
  assert.equal(typeof content, "string");
  assert.equal(String(content).includes("Blocked unsafe tool call (missing_path)."), true);
});

test("raw write without path is repaired from recent file context after tool result", async () => {
  const payload = await runProxy(
    JSON.stringify([
      {
        name: "write",
        arguments: { content: "fn main() { println!(\"updated\"); }" },
      },
    ]),
    [
      { role: "assistant", content: "Read snake_game/src/main.rs and prepare an update." },
      { role: "user", content: "apply the change" },
      { role: "tool", tool_call_id: "call_read_1", content: "<file>fn main() { println!(\"Hello\"); }</file>" },
    ],
  );
  const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
  assert.ok(Array.isArray(toolCalls));
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.function?.name, "write");
  const args = JSON.parse(toolCalls[0]?.function?.arguments || "{}");
  assert.equal(args.path, "snake_game/src/main.rs");
  assert.equal(typeof args.content, "string");
});

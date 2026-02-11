import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createToolDispatch } from "../src/proxy/handler/dispatch.js";
import { buildToolRegistry } from "../src/proxy/tools/registry.js";

const parseSseEvents = (sse: string): string[] =>
  sse
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.replace(/^data:\s*/i, ""));

test("proxy stages file mutation behind a read and replays mutation after tool result", () => {
  const filePath = path.join("webwrapper-eval", "tmp", "stage-mutation.txt");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "old\n", "utf8");

  const registry = buildToolRegistry([
    { function: { name: "read", parameters: { properties: { filePath: { type: "string" } } } } },
    {
      function: {
        name: "edit",
        parameters: {
          properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } },
        },
      },
    },
  ]);

  const rawDispatchState = { signature: "", user: "" };
  const { guardAndSendToolCalls, tryHandlePendingConfirmation } = createToolDispatch({ rawDispatchState });

  const writes: string[] = [];
  const reply: any = {
    header() {},
    raw: {
      writeHead() {},
      write(chunk: any) {
        writes.push(String(chunk));
      },
      end() {},
    },
    send(obj: any) {
      writes.push(JSON.stringify(obj));
    },
  };

  const toolCalls: any[] = [
    {
      id: "call_edit_1",
      index: 0,
      type: "function",
      function: { name: "edit", arguments: JSON.stringify({ filePath, oldString: "old\n", newString: "new\n" }) },
    },
  ];

  guardAndSendToolCalls(
    reply,
    toolCalls,
    "glm-4.7",
    true,
    {},
    undefined,
    0,
    undefined,
    "planner",
    registry,
    undefined,
    undefined,
    null,
    "scope_test",
  );

  const sse = writes.join("");
  const events = parseSseEvents(sse);
  const first = JSON.parse(events[0] as string);
  const stagedToolCalls = first.choices?.[0]?.delta?.tool_calls;
  assert.ok(Array.isArray(stagedToolCalls));
  assert.equal(stagedToolCalls[0]?.function?.name, "read");
  const stageId = stagedToolCalls[0]?.id;
  assert.ok(typeof stageId === "string" && stageId.length > 0);

  // Now simulate the tool result for the staged read: proxy should replay the original edit call.
  const replayWrites: string[] = [];
  const reply2: any = {
    header() {},
    raw: {
      writeHead() {},
      write(chunk: any) {
        replayWrites.push(String(chunk));
      },
      end() {},
    },
    send(obj: any) {
      replayWrites.push(JSON.stringify(obj));
    },
  };

  const request: any = {
    headers: {},
    body: {
      model: "glm-4.7",
      stream: true,
      messages: [
        { role: "user", content: "ok" },
        { role: "tool", tool_call_id: stageId, content: "<file>old</file>" },
      ],
    },
  };

  const handled = tryHandlePendingConfirmation(request, reply2);
  assert.equal(handled.handled, true);
  const replaySse = replayWrites.join("");
  const replayEvents = parseSseEvents(replaySse);
  const replayFirst = JSON.parse(replayEvents[0] as string);
  const replayToolCalls = replayFirst.choices?.[0]?.delta?.tool_calls;
  assert.ok(Array.isArray(replayToolCalls));
  assert.equal(replayToolCalls[0]?.function?.name, "edit");
});


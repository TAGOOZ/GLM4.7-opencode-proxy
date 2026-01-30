#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.PROXY_URL || "http://127.0.0.1:8787/v1/chat/completions";

async function post(payload) {
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

function expectContent(text) {
  const data = JSON.parse(text);
  const msg = data.choices?.[0]?.message;
  return typeof msg?.content === "string";
}

function expectToolCall(name, text) {
  const data = JSON.parse(text);
  const calls = data.choices?.[0]?.message?.tool_calls;
  if (!calls || !calls.length) return false;
  return calls[0].function?.name === name;
}

async function test(name, payload, expectFn) {
  try {
    const res = await post(payload);
    if (!res.ok) {
      console.log(`${name}: HTTP ${res.status}`);
      console.log(res.text.slice(0, 500));
      return false;
    }
    const ok = expectFn(res.text);
    console.log(`${name}: ${ok ? "OK" : "FAIL"}`);
    if (!ok) console.log(res.text.slice(0, 500));
    return ok;
  } catch (err) {
    console.log(`${name}: ERROR`, err?.message || err);
    return false;
  }
}

async function run() {
  const iterations = Number(process.env.ITERATIONS || 20);
  const pauseMs = Number(process.env.PAUSE_MS || 200);

  const payload1 = { model: "glm-4.7", messages: [{ role: "user", content: "Say hello in one sentence." }] };

  const payloadRead = {
    model: "glm-4.7",
    messages: [{ role: "user", content: "what is in requirements.txt" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "read file",
          parameters: { type: "object", properties: { filePath: { type: "string" } } },
        },
      },
    ],
  };

  const payloadWrite = {
    model: "glm-4.7",
    messages: [{ role: "user", content: "create a file test_write.txt with content hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "write",
          description: "write file",
          parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } } },
        },
      },
    ],
  };

  const payloadList = {
    model: "glm-4.7",
    messages: [{ role: "user", content: "list files" }],
    tools: [
      {
        type: "function",
        function: {
          name: "glob",
          description: "list",
          parameters: { type: "object", properties: { pattern: { type: "string" } } },
        },
      },
    ],
  };

  await test("plain", payload1, expectContent);
  await test("read_fallback", payloadRead, (t) => expectToolCall("read", t));
  await test("write_tool", payloadWrite, (t) => expectToolCall("write", t));
  await test("list_files", payloadList, (t) => expectToolCall("glob", t));

  let okCount = 0;
  let failCount = 0;
  let totalMs = 0;

  for (let i = 0; i < iterations; i += 1) {
    const start = Date.now();
    const ok = await test(`quick_${i + 1}`, payload1, expectContent);
    const elapsed = Date.now() - start;
    totalMs += elapsed;
    if (ok) okCount += 1;
    else failCount += 1;
    if ((i + 1) % 5 === 0) {
      await test(`periodic_read_${i + 1}`, payloadRead, (t) => expectToolCall("read", t));
      await test(`periodic_write_${i + 1}`, payloadWrite, (t) => expectToolCall("write", t));
      await test(`periodic_list_${i + 1}`, payloadList, (t) => expectToolCall("glob", t));
    }
    await delay(pauseMs);
  }

  const avgMs = okCount ? Math.round(totalMs / (okCount + failCount)) : 0;
  console.log(`summary: ok=${okCount} fail=${failCount} avg_ms=${avgMs}`);
}

run();

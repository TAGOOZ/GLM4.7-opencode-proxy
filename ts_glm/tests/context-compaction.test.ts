import test from "node:test";
import assert from "node:assert/strict";

import { compactMessages, estimateMessagesTokens, type ContextConfig } from "../src/proxy/context.js";

const baseConfig = (overrides: Partial<ContextConfig> = {}): ContextConfig => ({
  maxTokens: 1000,
  reserveTokens: 0,
  safetyMargin: 0,
  recentMessages: 2,
  minRecentMessages: 1,
  summaryMaxChars: 2000,
  toolMaxLines: 0,
  toolMaxChars: 0,
  ...overrides,
});

test("compactMessages drops older messages without summary when recent fits budget", () => {
  const sys = { role: "system", content: "sys" };
  const older1 = { role: "user", content: "A".repeat(400) };
  const older2 = { role: "assistant", content: "B".repeat(400) };
  const recent1 = { role: "user", content: "hi" };
  const recent2 = { role: "assistant", content: "ok" };

  const messages = [sys, older1, older2, recent1, recent2];
  const pinnedRecentTokens = estimateMessagesTokens([sys, recent1, recent2]);
  const config = baseConfig({ maxTokens: pinnedRecentTokens + 1 });

  const result = compactMessages(messages, config);
  assert.equal(result.stats.summaryAdded, false);
  // Older messages are dropped, but existing behavior does not count them unless a summary is added.
  assert.equal(result.stats.droppedMessages, 0);
  assert.deepEqual(result.messages, [sys, recent1, recent2]);
  assert.equal(result.stats.usedTokens, estimateMessagesTokens(result.messages));
});

test("compactMessages adds summary and drops recent until minRecentMessages when still over budget", () => {
  const sys = { role: "system", content: "sys" };
  const older1 = { role: "user", content: "A".repeat(400) };
  const older2 = { role: "assistant", content: "B".repeat(400) };
  const recent1 = { role: "user", content: "C".repeat(400) };
  const recent2 = { role: "assistant", content: "D".repeat(400) };

  const messages = [sys, older1, older2, recent1, recent2];
  const pinnedRecentTokens = estimateMessagesTokens([sys, recent1, recent2]);
  const config = baseConfig({ maxTokens: Math.max(1, pinnedRecentTokens - 1) });

  const result = compactMessages(messages, config);
  assert.equal(result.stats.summaryAdded, true);
  assert.equal(result.stats.droppedMessages, 3);
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0], sys);
  assert.equal(result.messages[1].role, "system");
  assert.match(result.messages[1].content, /^Context summary/i);
  assert.equal(result.messages[2], recent2);
  assert.equal(result.stats.usedTokens, estimateMessagesTokens(result.messages));
});


import test from "node:test";
import assert from "node:assert/strict";

import { createPromptTelemetryTracker } from "../src/proxy/handler/promptTelemetry.js";

test("prompt telemetry tracker records per-call stats and summary", () => {
  const tracker = createPromptTelemetryTracker();

  assert.equal(tracker.summary(), null);

  const first = tracker.record([
    { role: "system", content: "abc" },
    { role: "user", content: "hello" },
  ]);
  assert.deepEqual(first, {
    collect_call_index: 1,
    prompt_chars: 8,
    system_chars: 3,
    history_chars: 5,
    prompt_chars_delta_prev: 0,
    prompt_chars_delta_first: 0,
  });

  const second = tracker.record([
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
    { role: "system", content: "x" },
  ]);
  assert.deepEqual(second, {
    collect_call_index: 2,
    prompt_chars: 5,
    system_chars: 1,
    history_chars: 4,
    prompt_chars_delta_prev: -3,
    prompt_chars_delta_first: -3,
  });

  assert.deepEqual(tracker.summary(), {
    collect_calls: 2,
    prompt_chars_min: 5,
    prompt_chars_max: 8,
    prompt_chars_avg: 6.5,
    prompt_chars_first: 8,
    prompt_chars_last: 5,
  });
});

test("prompt telemetry summary rounds average to two decimals", () => {
  const tracker = createPromptTelemetryTracker();

  tracker.record([{ role: "user", content: "a" }]); // 1
  tracker.record([{ role: "user", content: "bc" }]); // 2
  tracker.record([{ role: "system", content: "de" }]); // 2

  const summary = tracker.summary();
  assert.equal(summary?.collect_calls, 3);
  assert.equal(summary?.prompt_chars_avg, 1.67);
  assert.equal(summary?.prompt_chars_min, 1);
  assert.equal(summary?.prompt_chars_max, 2);
});

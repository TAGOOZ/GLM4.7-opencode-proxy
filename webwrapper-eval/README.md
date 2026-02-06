# OpenCode-Only E2E Test Plan

This folder contains OpenCode-only E2E tests that exercise the TS proxy and tool planner via the OpenCode CLI.

## Quick Start

1) Start the TS proxy (example flags from the plan):

```bash
PROXY_DEBUG=1 PROXY_USE_GLM_HISTORY=1 npm --prefix ts_glm run start:proxy
```

2) In another shell, run the tests:

```bash
AGENT_CMD='opencode run -m glm-local/glm-4.7 --format json' \
  webwrapper-eval/run_all.sh
```

Evidence (stdout, stderr, checks) is written under `webwrapper-eval/evidence/<test_id>/`.

## Filters and Overrides

- `TEST_FILTER` (regex) filters which tests run. Example:

```bash
TEST_FILTER='^(e2e-|tool-)' AGENT_CMD='opencode run -m glm-local/glm-4.7 --format json' \
  webwrapper-eval/run_all.sh
```

- Per-test command override: `tests/<id>/agent_cmd.txt` can contain a full command or use `{AGENT_CMD}` as a placeholder.
- Per-test setup: `tests/<id>/setup.sh` runs before the agent command.
- Per-test env: `tests/<id>/env.sh` (if present) is sourced before the agent command.
- Check scripts may exit with code `3` to mark a **SKIP**.

## Proxy Log Assertions (Strict Mode)

Some strict tests require proxy debug logs. Start the proxy with logging redirected:

```bash
PROXY_DEBUG=1 PROXY_USE_GLM_HISTORY=1 npm --prefix ts_glm run start:proxy > /tmp/proxy.log 2>&1
export PROXY_LOG_FILE=/tmp/proxy.log
```

The runner records a byte offset before each test so log checks only scan new output.

## Test Mode (Strict Coverage)

Some strict checks rely on test-only directives gated by `PROXY_TEST_MODE=1`. These directives are **no-ops** unless test mode is enabled.

Supported directives:

- `/system <text>` injects a system message (for `ctx-always-send-system-log`)
- `/test tool_loop` injects a synthetic tool result to exercise the tool loop limit (`tool-loop-limit-log`)
- `/test no-heuristics` disables heuristic tool inference for the request (used by patch/edit sequencing tests)

Example:

```bash
PROXY_DEBUG=1 PROXY_TEST_MODE=1 npm --prefix ts_glm run start:proxy > /tmp/proxy.log 2>&1
export PROXY_LOG_FILE=/tmp/proxy.log
```

## Stress Tests

The stress suites are opt-in to avoid long runtimes:

```bash
RUN_STRESS=1 AGENT_CMD='opencode run -m glm-local/glm-4.7 --format json' \
  TEST_FILTER='^(long-chat-200-turns|parallel-requests)$' \
  webwrapper-eval/run_all.sh
```

## Web Search Tests

`tool-search-web` expects web search to be enabled:

```bash
PROXY_ALLOW_WEB_SEARCH=1 npm --prefix ts_glm run start:proxy
```

If `PROXY_ALLOW_WEB_SEARCH` is not set, the test will skip.

## Streaming Tests

`e2e-streaming` and `e2e-thinking-off` add `--stream` via `agent_cmd.txt` and skip if streaming isn’t detected in stdout.

## Notes on Context Tests

The `ctx-*` tests rely on proxy debug logs and will **skip** unless `PROXY_LOG_FILE` is set. Compaction tests also require `RUN_COMPACTION=1` and a low context budget so the reset path triggers.

## Strict Log-Based Tests

These tests assert proxy debug markers and will **skip** if `PROXY_LOG_FILE` is not set:

- `ctx-compaction-reset-log` (requires low context limits and `PROXY_COMPACT_RESET=1`)
- `ctx-summary-reset` (requires `RUN_COMPACTION=1` and low context limits)
- `ctx-drop-reset` (requires `RUN_COMPACTION=1` and low context limits)
- `planner-retry-log` (requires `PROXY_PLANNER_MAX_RETRIES=1`)
- `planner-retry2-log` (requires `PROXY_PLANNER_MAX_RETRIES=2`)
- `ctx-history-delta-log` (requires `PROXY_USE_GLM_HISTORY=1`)
- `ctx-always-send-system-log` (requires `PROXY_ALWAYS_SEND_SYSTEM=1`, `PROXY_USE_GLM_HISTORY=1`, and `PROXY_TEST_MODE=1`; uses `/system` directive)
- `ctx-new-chat-per-request-log` (requires `PROXY_NEW_CHAT_PER_REQUEST=1`)
- `tool-loop-limit-log` (requires `PROXY_TOOL_LOOP_LIMIT=1` and `PROXY_TEST_MODE=1`)

Recommended proxy env for compaction tests:

```bash
PROXY_DEBUG=1 PROXY_COMPACT_RESET=1 PROXY_CONTEXT_MAX_TOKENS=400 PROXY_CONTEXT_RESERVE_TOKENS=0 PROXY_CONTEXT_SAFETY_MARGIN=0 \\
  npm --prefix ts_glm run start:proxy > /tmp/proxy.log 2>&1
export PROXY_LOG_FILE=/tmp/proxy.log
```

Run compaction tests:

```bash
RUN_COMPACTION=1 TEST_FILTER='^ctx-(compaction-reset-log|summary-reset|drop-reset)$' \\
  AGENT_CMD='opencode run -m glm-local/glm-4.7 --format json' \\
  webwrapper-eval/run_all.sh
```

## Performance Tests

Performance checks are opt-in:

```bash
RUN_PERF=1 PERF_ITERATIONS=15 PERF_MAX_AVG_MS=4000 PERF_MAX_P95_MS=8000 \\
  AGENT_CMD='opencode run -m glm-local/glm-4.7 --format json' \\
  TEST_FILTER='^perf-' webwrapper-eval/run_all.sh
```

`perf-concurrency` uses:

- `PERF_CONCURRENCY` (default `10`)
- `PERF_REQUESTS` (default `20`)
- `PERF_MAX_FAILS` (default `0`)

## Parser Repair Tests

The `planner-comments`, `planner-trailing-commas`, and `planner-arguments-newline` tests exercise JSON normalization in the proxy parser. These prompts ask the model to output *invalid JSON* on purpose; if the model “fixes” the JSON itself, the test still passes, but it won’t validate the repair paths.

## Mode Matrix (Manual)

Run a short subset (`e2e-hello`, `tool-read`, `ctx-usage-headers`) under flag combinations by restarting the proxy for each mode:

- `PROXY_USE_GLM_HISTORY=0/1`
- `PROXY_ALWAYS_SEND_SYSTEM=0/1`
- `PROXY_COMPACT_RESET=0/1`
- `PROXY_ALLOW_WEB_SEARCH=0/1`
- `PROXY_NEW_CHAT_PER_REQUEST=0/1`

Example:

```bash
PROXY_USE_GLM_HISTORY=0 PROXY_ALWAYS_SEND_SYSTEM=1 npm --prefix ts_glm run start:proxy
TEST_FILTER='^(e2e-hello|tool-read|ctx-usage-headers)$' \
  AGENT_CMD='opencode run -m glm-local/glm-4.7 --format json' \
  webwrapper-eval/run_all.sh
```

## Test-to-Module Mapping

- `context.ts`: `ctx-*`, `large-*`
- `messages.ts`: `e2e-thinking-off`, tool prompt directives
- `tools/parse.ts`: `planner-*`
- `tools/infer.ts`: `tool-*` (read/write/run/list)
- `tools/registry.ts`: `tool-unknown`, tool name normalization
- `openai.ts`: `e2e-streaming`, `ctx-usage-headers`
- `handler.ts`: history/delta mode, compaction reset, tool loop handling
- `index.ts`: `ctx-new-chat-per-request-log`

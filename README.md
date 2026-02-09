# GLM 4.7 OpenCode Proxy (TypeScript-first)

This repository provides an OpenAI-compatible proxy and CLI for GLM on `chat.z.ai`.

## Fast Favorite Start (Go Flow)

Use this exact order:

1. Install and build.
```bash
npm run install:all
npm run build:all
```

2. Install Playwright once, then login from CLI.
```bash
cd ts_glm
npx playwright install
npm run start:cli -- login
```

3. Start the local GLM proxy.
```bash
npm run start:proxy
```

4. Open OpenCode, choose model `glm-local/glm-4.7`, then go.
```bash
opencode
```

5. Optional quick one-liner test (no UI selection needed).
```bash
opencode run -m glm-local/glm-4.7 "Say hello in one line"
```

## README Pillars

This README is organized around 5 code-backed pillars:

1. **Runtime map**: where request handling, planning, guards, and confirmation logic actually live.
2. **Verified runbook**: commands that match current `package.json` scripts and CLI commands.
3. **Guard behavior**: what is allowed, what is confirmed, and what is blocked.
4. **Configuration truth table**: env vars and defaults from `ts_glm/src/proxy/constants.ts`.
5. **Failure-driven troubleshooting**: common issues (including `question` payload shape errors) with valid payload examples.

## 1) Runtime Map (Source of Truth)

TypeScript is the active implementation path.

| Area | Source |
|---|---|
| Proxy entrypoint | `ts_glm/src/proxy/index.ts` |
| Main request handler | `ts_glm/src/proxy/handler.ts` |
| Request prep (tools, directives, history, heuristics) | `ts_glm/src/proxy/handler/request.ts` |
| Planner flow | `ts_glm/src/proxy/handler/plannerFlow.ts` |
| Raw tool-call dispatch | `ts_glm/src/proxy/handler/rawDispatchFlow.ts` |
| Tool-call validation and guards | `ts_glm/src/proxy/handler/guardValidation.ts` |
| Mutation boundary logic | `ts_glm/src/proxy/handler/guardMutation.ts` |
| Confirmation builder | `ts_glm/src/proxy/handler/guardValidation/confirm.ts` |
| Shell safety (allowlist+denylist) | `ts_glm/src/proxy/tools/shellSafety.ts`, `web_wrapper/src/safety.ts` |
| Path safety | `ts_glm/src/proxy/tools/pathSafety.ts` |
| CLI entrypoint | `ts_glm/src/cli.ts` |

Python (`glm_cli/`, `glm_proxy/`) remains legacy-compatible and read-only by default.

## 2) Verified Runbook

### Install and build

```bash
npm run install:all
npm run build:all
```

### Configure token

```bash
npm --prefix ts_glm run start:cli -- config --token "YOUR_TOKEN"
```

Token loading order is:
1. `GLM_TOKEN` env var
2. `~/.config/glm-cli/config.json`

The CLI also writes `GLM_TOKEN=...` into `.env` in repo root when possible.

### Start proxy

```bash
npm --prefix ts_glm run start:proxy
```

Default bind is `http://127.0.0.1:8787` (`HOST` and `PORT` are supported).

### Start CLI

```bash
npm --prefix ts_glm run start:cli -- --help
npm --prefix ts_glm run start:cli -- chats
npm --prefix ts_glm run start:cli -- new --title "My Chat" --model glm-4.7
npm --prefix ts_glm run start:cli -- chat CHAT_ID "Hello"
npm --prefix ts_glm run start:cli -- interactive
npm --prefix ts_glm run start:cli -- whoami
```

### Login (Playwright)

```bash
cd ts_glm
npx playwright install
npm run start:cli -- login
```

Useful options from `login` command:
- `--check`
- `--channel <chrome|chromium|msedge>`
- `--connect-cdp <url>`
- `--remote-debugging-port <port>`
- `--chrome-bin <path>`
- `--allow-guest`

## 3) Proxy API + Guard Model

### OpenAI-compatible endpoints

- `GET /v1/models` and `GET /models`
- `POST /v1/chat/completions` and `POST /chat/completions`

### Minimal API call

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.7",
    "messages": [{"role":"user","content":"Say hello"}],
    "stream": false
  }'
```

### Thinking and search toggles

You can pass flags directly in request body (`enable_thinking`, `web_search`, `auto_web_search`) or with prompt directives:

- `/thinking on|off`
- `/think on|off`
- `/search on|off`
- `/web on|off`
- `/auto-search on|off`

Directives are stripped before model content is sent.

### Guard behavior (current)

- Tool calls are validated by `validateToolCalls()`.
- Guard failures are usually confirmable if a confirmation tool exists (`question`, `askquestion`, `confirm`, etc.).
- Non-confirmable guard reasons are limited (`unexpected_arg`, `invalid_content_type`).
- `read`/`list` with missing path are auto-repaired to `"."`.
- `write` without content still requires confirmation (or blocks if no confirm tool).
- `tool_choice` mismatches are routed through confirmation flow when possible.
- Unknown `tool_choice` function name is returned as content error early.
- Planner mutation boundary allows at most one mutation action in a planner response.
- `PROXY_MAX_ACTIONS_PER_TURN` default is unlimited (`0` means no cap).
- Raw tool-call early gate no longer drops unknown non-mutation tool names.
- Shell allowlist checks are active only when `PROXY_ALLOW_ANY_COMMAND=0`.
- `rm/rmdir/del` are only treated as dangerous by heuristic when high-risk flags/targets are present.

## 4) Confirmation Payloads (`question` tool)

If client already exposes a `question`/`askquestion` tool, proxy uses that schema. If no confirmation tool is provided, proxy injects a minimal fallback:

```json
{
  "question": "Proceed?"
}
```

If your tool expects `questions[]`, each option must be an object (not a plain string):

```json
{
  "questions": [
    {
      "header": "Confirm",
      "id": "confirm_abc123",
      "question": "Proceed with this action?",
      "options": [
        {
          "label": "Proceed (Recommended)",
          "description": "Approve the action and continue."
        },
        {
          "label": "Cancel",
          "description": "Decline the action and stop."
        }
      ]
    }
  ]
}
```

If you pass string options like `"Yes"`, schema validation can fail with errors like “expected object, received string”.

## 5) Config Truth Table

Key proxy env vars and defaults:

| Env var | Default | Effect |
|---|---|---|
| `PROXY_DEBUG` | `0` | Enable proxy debug logs/dumps |
| `PROXY_NEW_CHAT_PER_REQUEST` | `0` | Create fresh GLM chat per request |
| `PROXY_ALLOW_WEB_SEARCH` | `1` | Allow web tools (`webfetch`, `websearch`) |
| `PROXY_ALLOW_NETWORK` | `1` | Allow networked shell commands |
| `PROXY_ALLOW_EXPLICIT_MUTATIONS` | `1` | Allow mutation tools from explicit tool calls |
| `PROXY_ALLOW_RAW_MUTATIONS` | `1` | Allow mutation tools from raw tool_calls |
| `PROXY_ALLOW_ANY_COMMAND` | `1` | Skip shell allowlist-first checks |
| `PROXY_CONFIRM_DANGEROUS_COMMANDS` | `1` | Require confirmation for dangerous commands |
| `PROXY_MAX_ACTIONS_PER_TURN` | `0` | Max actions per turn (`<=0` = unlimited) |
| `PROXY_TOOL_LOOP_LIMIT` | `0` | Max tool loop rounds (`<=0` = unlimited) |
| `PROXY_PLANNER_MAX_RETRIES` | `1` | Planner parse retry attempts |
| `PROXY_PLANNER_COERCE` | `1` | Coerce planner failures into direct final answer |
| `PROXY_ALLOW_USER_HEURISTICS` | `1` | Enable fallback heuristic tool inference |
| `PROXY_USE_GLM_HISTORY` | `1` | Reuse GLM-side history across requests |
| `PROXY_STRIP_HISTORY` | `0` | Strip prior history from incoming messages |
| `PROXY_DEFAULT_THINKING` | `1` | Enable thinking by default |
| `PROXY_TOOL_PROMPT_SCHEMA_MAX_CHARS` | `500` | Max schema chars included per tool when schema inclusion is enabled |
| `PROXY_TOOL_PROMPT_EXTRA_SYSTEM_MAX_CHARS` | `500` | Max chars from extra system instructions merged into tool prompt |
| `PROXY_WORKSPACE_ROOT` | unset | Optional workspace roots for path containment |

Context sizing vars also exist (`PROXY_CONTEXT_*`) in `ts_glm/src/proxy/constants.ts`.

## OpenCode Setup

`opencode.json` is preconfigured for:
- Provider: `glm-local`
- Base URL: `http://127.0.0.1:8787/v1`
- Model: `glm-4.7`

Run:

```bash
opencode run -m glm-local/glm-4.7 "Your prompt"
```

For detailed OpenCode-specific notes and file-attachment workarounds, see `OPENCODE_USAGE.md`.

## Validation Matrix (Run What You Touch)

- Changes in `web_wrapper/`:
```bash
npm --prefix web_wrapper run test
```

- Changes in `ts_glm/src/`:
```bash
npm --prefix ts_glm run build
npm --prefix ts_glm run test
```

- Cross-cutting protocol/request format changes:
```bash
npm run build:all
npm --prefix web_wrapper run test
```

- Python legacy changes:
```bash
python -m py_compile glm_cli/*.py glm_proxy/*.py
```

## Python Legacy Path

Python implementations (`glm_cli/`, `glm_proxy/`) are legacy-compatible.

By default, Python mode is read-only for safer behavior:
- Proxy tool-call emission is disabled.
- Mutation/auth commands are blocked unless explicitly re-enabled.

To temporarily re-enable legacy mutation/tool behavior:

```bash
export GLM_PY_LEGACY_ENABLE_MUTATIONS=1
export GLM_PY_LEGACY_ENABLE_TOOLS=1
```

## License

MIT

# GLM 4.7 CLI Tool

A command-line interface for interacting with the GLM4.7 API at [chat.z.ai](https://chat.z.ai).

## Installation (TypeScript, Primary)

The TypeScript proxy/CLI is the main, actively developed path. The Python proxy was the initial MVP and is kept for compatibility.

```bash
cd GLM4.7-opencode-proxy
npm run install:all
npm run build:all
```

Start the proxy:

```bash
cd ts_glm
npm run start:proxy
```

Run the CLI:

```bash
cd ts_glm
npm run start:cli -- login
npm run start:cli -- chat <CHAT_ID> "Hello"
```

First-time Playwright setup (for `login`):

```bash
cd ts_glm
npx playwright install
```

### TypeScript CLI Login Notes

If Google blocks the automated browser with a "This browser or app may not be secure" message, the Playwright login flow will not complete. In that case, use a real browser to obtain the token and set it with the CLI:

```bash
npm --prefix ts_glm run start:cli -- config --token "YOUR_TOKEN"
```

You can also try launching with a real Chrome channel and a dedicated profile:

```bash
npm --prefix ts_glm run start:cli -- login --channel chrome
```

This uses a separate profile directory under `~/.config/glm-cli/` by default.

If Google blocks automated login, the CLI will auto-launch Chrome with remote debugging by default. You can also connect to an already-running Chrome session:

```bash
google-chrome --user-data-dir=~/.config/glm-cli/chrome-debug --remote-debugging-port=9222
npm --prefix ts_glm run start:cli -- login --connect-cdp http://127.0.0.1:9222
```

Log in to chat.z.ai in that browser window, then return to the CLI.

If Chrome/Chromium is not on your PATH, pass a binary explicitly:

```bash
npm --prefix ts_glm run start:cli -- login --chrome-bin /opt/google/chrome/chrome
```

## Thinking and Web Search Flags (TypeScript Proxy)

The proxy accepts GLM flags for thinking and web search. You can pass them in the request body as either top-level fields or under `features`.

Thinking is enabled by default. You can still toggle it explicitly:

```json
{
  "model": "glm-4.7",
  "messages": [{"role":"user","content":"Explain this"}],
  "enable_thinking": true
}
```

Enable/disable web search (allowed by default):

```json
{
  "model": "glm-4.7",
  "messages": [{"role":"user","content":"Latest news on X"}],
  "web_search": true,
  "auto_web_search": true
}
```

To block web search through the proxy, set:

```bash
export PROXY_ALLOW_WEB_SEARCH=0
```

### TUI Quick Toggles

In OpenCode TUI (or any client), you can add a directive line to the user prompt to toggle flags:

```
/thinking on
/search on
/auto-search on
```

These directive lines are stripped before sending content to the model, and only affect the proxy flags.

OpenCode renders `reasoning_content` in a dedicated thinking panel. The proxy now streams thinking there and keeps the final answer separate. If you want faster responses, use `/thinking off` (thinking mode can add noticeable latency).

## Security Model (Proxy + Runner)

This repo follows an OpenCode-style safety model with agentic defaults:

- **Mutations require validated planner JSON unless explicit/raw mutation flags are enabled (enabled by default).**
- **Heuristic allowlist:** `read`, `list/glob`, `grep/search` only.
- **Runner is the security boundary:** repo-root jail, sensitive-path denylist, output redaction, and size caps.
**Confirmations are handled by the client** (e.g., OpenCode permission prompts).
This proxy does not require custom tool arguments for approvals.

Additional proxy safety toggles:

- `PROXY_ALLOW_WEB_SEARCH=0` block webfetch/web_search tools (default on).
- `PROXY_ALLOW_NETWORK=0` block networked shell commands (default on).
- `PROXY_ALLOW_EXPLICIT_MUTATIONS=0` block mutation tools from explicit tool calls.
- `PROXY_ALLOW_RAW_MUTATIONS=0` block mutation tools from raw tool_calls.
- `PROXY_ALLOW_ANY_COMMAND=0` enforce shell allowlist/denylist checks.
- `PROXY_CONFIRM_DANGEROUS_COMMANDS=0` disable confirmation flow for dangerous commands and deletes.
- `PROXY_NEW_CHAT_PER_REQUEST=0` reuse a single GLM chat across requests.
- `PROXY_STRIP_HISTORY=0` keep full incoming message history (default keeps only latest user turn unless tool messages are present).

Examples:

```json
{"tool":"read","args":{"filePath":"README.md"}}
```

```json
{"tool":"write","args":{"filePath":"notes.txt","content":"..."}}
```

```json
{"tool":"run_shell","args":{"command":"mv foo bar"}}
```

Note: `rm` is not in the default allowlist if you enable allowlist checks.

## Quick Start (Token)

Pick one of these:

### Option A: Env var (simplest)

```bash
cp .env.example .env
# edit .env and set GLM_TOKEN=YOUR_TOKEN
```

or:

```bash
export GLM_TOKEN="YOUR_TOKEN"
```

### Option B: CLI config

```bash
npm --prefix ts_glm run start:cli -- config --token "YOUR_TOKEN"
```

## Getting Your Token

1. Go to [chat.z.ai](https://chat.z.ai) and log in
2. Open browser DevTools (F12) → Network tab
3. Make any request and find the `Authorization` header
4. Copy the token after `Bearer `

Alternatively, check your cookies for the `token` value.

## Usage (TypeScript CLI)

### Configure Token

```bash
npm --prefix ts_glm run start:cli -- config --token "YOUR_TOKEN_HERE"
```

### Login (Browser / Google OAuth)

```bash
npm --prefix ts_glm run start:cli -- login
npm --prefix ts_glm run start:cli -- login --check
```

If this is your first time using Playwright:

```bash
npx playwright install
```

This command saves the token to both:
- `~/.config/glm-cli/config.json`
- `.env` (as `GLM_TOKEN=...`)

### List Chats

```bash
npm --prefix ts_glm run start:cli -- chats
npm --prefix ts_glm run start:cli -- chats --page 2
```

### Create New Chat

```bash
npm --prefix ts_glm run start:cli -- new
npm --prefix ts_glm run start:cli -- new --title "My Chat" --model glm-4.7
```

### Send a Message

```bash
npm --prefix ts_glm run start:cli -- chat CHAT_ID "Hello, how are you?"
npm --prefix ts_glm run start:cli -- chat CHAT_ID "What is Python?" --no-thinking
```

### Interactive Mode

```bash
npm --prefix ts_glm run start:cli -- interactive
npm --prefix ts_glm run start:cli -- interactive --chat-id EXISTING_CHAT_ID
```

Commands in interactive mode:
- `/quit` - Exit
- `/clear` - Clear conversation history

### Check Current User

```bash
npm --prefix ts_glm run start:cli -- whoami
```

## Available Models

- `glm-4.7` (default) - Latest GLM model with thinking capability
- `glm-4.6` - Previous version

## Features

- **Streaming responses** - See responses as they're generated
- **Thinking mode** - View the model's reasoning process (separate OpenCode thinking panel)
- **Interactive mode** - REPL-style conversation (`npm --prefix ts_glm run start:cli -- interactive`)
- **Rich terminal output** - Beautiful formatting with colors

## Configuration

Config is stored at `~/.config/glm-cli/config.json`

## OpenCode Setup (Local Proxy)

Start the proxy (TypeScript):

```bash
cd ts_glm
npm run start:proxy
```

Or start the proxy (Python, legacy read-only mode):

```bash
source venv/bin/activate
python3 -m uvicorn glm_proxy.server:app --host 127.0.0.1 --port 8787
```

Use `opencode.json` and select provider `glm-local`.

**Note**: For detailed usage instructions, including file attachment workarounds and troubleshooting, see [OPENCODE_USAGE.md](OPENCODE_USAGE.md).

## Python (MVP / Legacy)

The Python CLI/proxy is the original MVP and is now legacy.

Default behavior is read-only:
- Python proxy does not emit tool calls.
- Python CLI mutation/auth commands are blocked (`config`, `login`, `new`, `chat`, `interactive`).
- Read-style commands remain available (`chats`, `whoami`).

```bash
cd GLM4.7-opencode-proxy
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Python CLI examples (read-only by default):

```bash
python -m glm_cli.cli chats
python -m glm_cli.cli whoami
```

Python proxy:

```bash
python3 -m uvicorn glm_proxy.server:app --host 127.0.0.1 --port 8787
```

Temporary legacy override (not recommended):

```bash
export GLM_PY_LEGACY_ENABLE_MUTATIONS=1
export GLM_PY_LEGACY_ENABLE_TOOLS=1
```

## License

MIT

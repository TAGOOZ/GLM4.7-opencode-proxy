# GLM4.7 CLI Tool

A command-line interface for interacting with the GLM4.7 API at [chat.z.ai](https://chat.z.ai).

## Installation

```bash
cd GLM4.7-opencode-proxy

# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

## TypeScript (No Python)

If you want to run everything in TypeScript (no Python bridge):

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
python -m glm_cli.cli config --token "YOUR_TOKEN"
```

## Getting Your Token

1. Go to [chat.z.ai](https://chat.z.ai) and log in
2. Open browser DevTools (F12) → Network tab
3. Make any request and find the `Authorization` header
4. Copy the token after `Bearer `

Alternatively, check your cookies for the `token` value.

## Usage

### Configure Token

```bash
python -m glm_cli.cli config --token "YOUR_TOKEN_HERE"
```

### Login (Browser / Google OAuth)

```bash
python -m glm_cli.cli login
python -m glm_cli.cli login --check
```

If this is your first time using Playwright:

```bash
playwright install
```

This command saves the token to both:
- `~/.config/glm-cli/config.json`
- `.env` (as `GLM_TOKEN=...`)

### List Chats

```bash
python -m glm_cli.cli chats
python -m glm_cli.cli chats --page 2
```

### Create New Chat

```bash
python -m glm_cli.cli new
python -m glm_cli.cli new --title "My Chat" --model glm-4.7
```

### Send a Message

```bash
python -m glm_cli.cli chat CHAT_ID "Hello, how are you?"
python -m glm_cli.cli chat CHAT_ID "What is Python?" --no-thinking
```

### Interactive Mode

```bash
python -m glm_cli.cli interactive
python -m glm_cli.cli interactive --chat-id EXISTING_CHAT_ID
```

Commands in interactive mode:
- `/quit` - Exit
- `/clear` - Clear conversation history

### Check Current User

```bash
python -m glm_cli.cli whoami
```

## Available Models

- `glm-4.7` (default) - Latest GLM model with thinking capability
- `glm-4.6` - Previous version

## Features

- **Streaming responses** - See responses as they're generated
- **Thinking mode** - View the model's reasoning process
- **Interactive mode** - REPL-style conversation
- **Rich terminal output** - Beautiful formatting with colors

## Configuration

Config is stored at `~/.config/glm-cli/config.json`

## OpenCode Setup (Local Proxy)

Start the proxy (TypeScript):

```bash
cd ts_glm
npm run start:proxy
```

Or start the proxy (Python):

```bash
source venv/bin/activate
python3 -m uvicorn glm_proxy.server:app --host 127.0.0.1 --port 8787
```

Use `opencode.json` and select provider `glm-local`.

**Note**: For detailed usage instructions, including file attachment workarounds and troubleshooting, see [OPENCODE_USAGE.md](OPENCODE_USAGE.md).

## License

MIT

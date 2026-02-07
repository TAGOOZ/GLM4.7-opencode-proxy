# Repository Guidelines

## Scope and Priorities
- TypeScript (`ts_glm/`) is the primary implementation path for proxy + CLI.
- Python (`glm_proxy/`, `glm_cli/`) is legacy-compatible; avoid behavioral expansion there unless explicitly requested.
- Keep changes targeted; avoid broad refactors unless they are necessary for the task.

## Project Structure
- `glm_cli/`: Python CLI implementation (`python -m glm_cli.cli ...`).
- `glm_proxy/`: Python FastAPI/uvicorn proxy server (`glm_proxy/server.py`).
- `ts_glm/`: TypeScript CLI + proxy (`src/` source, `dist/` build output, `tests/`).
- `web_wrapper/`: TypeScript protocol package (`src/`, `tests/`, `dist/`).
- Root `package.json`: workspace-style scripts for multi-package install/build.
- `opencode.json`: OpenCode provider config that points to local proxy.

## Source of Truth
- Edit TypeScript in `src/`; do not hand-edit generated `dist/` files.
- Keep patches small and scoped to requested behavior.
- Follow existing local conventions instead of introducing new styles/tooling.

## Build, Run, and Test Commands
- Python setup:
  - `python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt`
- Python auth:
  - `python -m glm_cli.cli login`
  - `python -m glm_cli.cli config --token "TOKEN"`
- Python proxy:
  - `python3 -m uvicorn glm_proxy.server:app --host 127.0.0.1 --port 8787`
- TypeScript workspace:
  - `npm run install:all`
  - `npm run build:all`
- TypeScript dev/runtime:
  - `npm --prefix ts_glm run dev:proxy`
  - `npm --prefix ts_glm run dev:cli`
  - `npm --prefix ts_glm run start:proxy`
  - `npm --prefix ts_glm run start:cli`
- Tests:
  - `npm --prefix web_wrapper run test`
  - `npm --prefix ts_glm run test`

## Validation Matrix (Run What You Touch)
- Changes under `web_wrapper/`:
  - Run `npm --prefix web_wrapper run test`.
- Changes under `ts_glm/src/`:
  - Run `npm --prefix ts_glm run build`.
  - Run `npm --prefix ts_glm run test` when behavior is affected.
- Changes under `glm_cli/` or `glm_proxy/`:
  - At minimum, run `python -m py_compile glm_cli/*.py glm_proxy/*.py` for syntax checks.
- Cross-cutting changes (shared protocol, request/response formats, tool payloads):
  - Run `npm run build:all` and `npm --prefix web_wrapper run test`.

## Coding Style
- TypeScript:
  - ES modules, 2-space indent, double quotes, semicolons.
  - Keep modules focused; prefer small helpers over deeply nested logic.
- Python:
  - 4-space indent; keep functions explicit and side effects clear.
- No repo-wide formatter/linter is enforced; match surrounding code style.

## Commit and PR Expectations
- Commit messages: short, imperative, capitalized (e.g., `Fix parser fallback`).
- PR description should include:
  - What changed.
  - Why it changed.
  - Exact commands run for verification.
  - Any env vars or setup required to reproduce.

## Security and Config
- Never commit tokens, cookies, or local config artifacts.
- Token locations:
  - `~/.config/glm-cli/config.json`
  - `.env` as `GLM_TOKEN`
- Playwright (for browser login) one-time setup:
  - `cd ts_glm && npx playwright install`
- If adding logs, redact authorization headers and bearer tokens.

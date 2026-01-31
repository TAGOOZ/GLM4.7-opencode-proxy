# Repository Guidelines

## Project Structure & Module Organization
- `glm_cli/`: Python CLI implementation (`python -m glm_cli.cli ...`).
- `glm_proxy/`: Python FastAPI/uvicorn proxy server (`glm_proxy/server.py`).
- `ts_glm/`: TypeScript CLI + proxy source (`src/`) and build output (`dist/`).
- `web_wrapper/`: TypeScript protocol package with tests in `tests/` and build output in `dist/`.
- Root `package.json`: workspace-style scripts to build and test TS packages.
- `opencode.json`: OpenCode provider configuration for the local proxy.

## Build, Test, and Development Commands
- `python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt`: set up Python deps.
- `python -m glm_cli.cli login` or `python -m glm_cli.cli config --token "TOKEN"`: configure authentication.
- `python3 -m uvicorn glm_proxy.server:app --host 127.0.0.1 --port 8787`: run Python proxy.
- `npm run install:all` / `npm run build:all`: install/build all TS packages from repo root.
- `npm --prefix ts_glm run dev:proxy` or `dev:cli`: run TS proxy/CLI via `ts-node`.
- `npm --prefix ts_glm run start:proxy` / `start:cli`: run compiled JS from `dist/`.
- `npm --prefix web_wrapper run test`: build and run Vitest suite for `web_wrapper/`.

## Coding Style & Naming Conventions
- TypeScript: ES modules, `*.ts` in `src/`, compiled to `dist/`. Existing code uses 2‑space indent, double quotes, and semicolons — follow the local style.
- Python: standard 4‑space indent; keep modules in `glm_cli/` and `glm_proxy/`.
- No repo-wide formatter/linter config detected; keep changes minimal and consistent with nearby files.

## Testing Guidelines
- `web_wrapper/` uses Vitest; tests are named `*.test.ts` in `web_wrapper/tests/`.
- `ts_glm/` currently reports “no tests yet”; add tests alongside new features when possible.
- Python tests are not present; if adding, prefer `tests/` at the repo root or within the Python package.

## Commit & Pull Request Guidelines
- Commit history shows short, imperative, capitalized subjects (e.g., “Fix …”, “Add …”). Keep messages concise and descriptive.
- PRs should include: a summary of changes, how to run relevant tests, and any setup/config changes. Add screenshots only if UI output changes.

## Security & Configuration Tips
- Tokens live in `~/.config/glm-cli/config.json` and/or `.env` as `GLM_TOKEN`. Never commit tokens or local config files.
- For browser-based login, install Playwright once: `npx playwright install` from `ts_glm/`.

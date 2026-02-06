# Ralph Wiggum Workflow (Project Prompt)

Goal: work through open issues with short, safe iterations. The agent chooses the next task each run. Produce working code with small commits.

Rules:
- Pick exactly one issue per run, chosen by you from ralph/plan.md.
- Prioritize risky work first: safety/security changes, architectural decisions, integration points.
- Keep the change minimal and focused.
- Leave the repo in a clean state.
- Update ralph/progress.txt with: task completed, key decisions, files changed, blockers/notes.
- If there are no relevant tests, say so in progress.
- Use model size based on task scope: medium for small/perf tweaks, high for safety/security changes, extra for large refactors.
- Default mapping: medium=gpt-5.1-codex-mini, high=gpt-5.3-codex, extra=gpt-5.1-codex-max (override with env vars).
- Reasoning effort mapping: medium=medium, high=high, extra=xhigh (override with env vars).
- This is production-quality code; avoid shortcuts and preserve behavior.

Required structure for each run:
1) Restate the chosen issue and acceptance criteria.
2) Make the smallest change that meets the criteria.
3) Run the most relevant tests or explain why not (types/tests/lint if applicable).
4) Summarize the change, commit it, and update progress.
5) Stop.

Finish the response with the literal line:
COMPLETE

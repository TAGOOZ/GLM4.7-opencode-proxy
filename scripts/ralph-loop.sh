#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <iterations>"
  exit 1
fi

ITERATIONS=$1

if [[ -z "${AI_CMD:-}" ]] && ! command -v "${CODEX_BIN:-codex}" >/dev/null 2>&1; then
  echo "Set AI_CMD or configure CODEX_BIN/CODEX_MODEL/CODEX_PROMPT_FLAG."
  exit 1
fi

for i in $(seq 1 "$ITERATIONS"); do
  echo "---- Ralph iteration $i/$ITERATIONS ----"
  ./scripts/ralph-once.sh
  echo "---- End iteration $i ----"
  echo ""
  sleep 1
  
  # Stop if the last run wrote COMPLETE to progress (manual signal).
  if tail -n 1 ralph/progress.txt | rg -q "^COMPLETE$"; then
    echo "COMPLETE detected in progress log. Stopping."
    exit 0
  fi

done

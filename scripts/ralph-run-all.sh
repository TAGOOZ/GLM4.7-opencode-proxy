#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <iterations>"
  exit 1
fi

ITERATIONS=$1

CODEX_MODEL=${CODEX_MODEL:-gpt-5.3-codex}
CODEX_EFFORT=${CODEX_EFFORT:-high}

if [[ -z "${AI_CMD:-}" ]] && ! command -v "${CODEX_BIN:-codex}" >/dev/null 2>&1; then
  echo "Set AI_CMD or configure CODEX_BIN/CODEX_MODEL/CODEX_PROMPT_FLAG."
  exit 1
fi

for i in $(seq 1 "$ITERATIONS"); do
  echo "---- Ralph iteration $i/$ITERATIONS ----"
  export CODEX_MODEL
  export CODEX_EFFORT
  ./scripts/ralph-once.sh
  echo "---- End iteration $i ----"
  echo ""
  sleep 1

  if tail -n 1 ralph/progress.txt | rg -q "^COMPLETE$"; then
    echo "COMPLETE detected in progress log. Stopping."
    exit 0
  fi
done

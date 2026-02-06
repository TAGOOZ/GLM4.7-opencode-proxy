#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
PROMPT_FILE="$ROOT_DIR/ralph/prompt.md"
PLAN_FILE="$ROOT_DIR/ralph/plan.md"
PROGRESS_FILE="$ROOT_DIR/ralph/progress.txt"
OUT_FILE="$ROOT_DIR/ralph/combined-prompt.txt"
CURRENT_ISSUE_FILE="$ROOT_DIR/ralph/current-issue.txt"

cat "$PROMPT_FILE" > "$OUT_FILE"
echo "" >> "$OUT_FILE"
if [[ -f "$CURRENT_ISSUE_FILE" ]]; then
  cat "$CURRENT_ISSUE_FILE" >> "$OUT_FILE"
  echo "" >> "$OUT_FILE"
fi
cat "$PLAN_FILE" >> "$OUT_FILE"
echo "" >> "$OUT_FILE"
cat "$PROGRESS_FILE" >> "$OUT_FILE"

if [[ -n "${AI_CMD:-}" ]]; then
  "$AI_CMD" "$OUT_FILE"
  exit 0
fi

CODEX_BIN=${CODEX_BIN:-codex}
CODEX_MODEL=${CODEX_MODEL:-}
CODEX_SUBCOMMAND=${CODEX_SUBCOMMAND:-exec}
CODEX_EFFORT=${CODEX_EFFORT:-}
CODEX_ARGS=${CODEX_ARGS:-}
CODEX_PROMPT_MODE=${CODEX_PROMPT_MODE:-arg}
CODEX_PROMPT_FLAG=${CODEX_PROMPT_FLAG:-}

if command -v "$CODEX_BIN" >/dev/null 2>&1; then
  EFFORT_ARGS=()
  if [[ -n "$CODEX_EFFORT" ]]; then
    EFFORT_ARGS=(-c "model_reasoning_effort=${CODEX_EFFORT}")
  fi

  if [[ -n "$CODEX_PROMPT_FLAG" ]]; then
    if [[ -n "$CODEX_MODEL" ]]; then
      "$CODEX_BIN" "$CODEX_SUBCOMMAND" "${EFFORT_ARGS[@]}" $CODEX_ARGS --model "$CODEX_MODEL" "$CODEX_PROMPT_FLAG" "$OUT_FILE"
    else
      "$CODEX_BIN" "$CODEX_SUBCOMMAND" "${EFFORT_ARGS[@]}" $CODEX_ARGS "$CODEX_PROMPT_FLAG" "$OUT_FILE"
    fi
    exit 0
  fi

  if [[ "$CODEX_PROMPT_MODE" == "stdin" ]]; then
    if [[ -n "$CODEX_MODEL" ]]; then
      cat "$OUT_FILE" | "$CODEX_BIN" "$CODEX_SUBCOMMAND" "${EFFORT_ARGS[@]}" $CODEX_ARGS --model "$CODEX_MODEL"
    else
      cat "$OUT_FILE" | "$CODEX_BIN" "$CODEX_SUBCOMMAND" "${EFFORT_ARGS[@]}" $CODEX_ARGS
    fi
    exit 0
  fi

  if [[ -n "$CODEX_MODEL" ]]; then
    "$CODEX_BIN" "$CODEX_SUBCOMMAND" "${EFFORT_ARGS[@]}" $CODEX_ARGS --model "$CODEX_MODEL" "$(cat "$OUT_FILE")"
  else
    "$CODEX_BIN" "$CODEX_SUBCOMMAND" "${EFFORT_ARGS[@]}" $CODEX_ARGS "$(cat "$OUT_FILE")"
  fi
  exit 0
fi

echo "AI_CMD is not set and codex was not found. Prompt saved to: $OUT_FILE"
echo "Set AI_CMD or configure CODEX_BIN/CODEX_MODEL/CODEX_PROMPT_FLAG."

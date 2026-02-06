#!/usr/bin/env bash
set -euo pipefail
if [[ "${RUN_COMPACTION:-}" != "1" ]]; then
  echo "RUN_COMPACTION not set; skipping." >&2
  exit 0
fi
BASE_CMD_RAW="${AGENT_CMD_BASE:-${AGENT_CMD:-opencode run -m glm-local/glm-4.7 --format json}}"
session_id="ctx-compact-$$-$(date +%s)"

payload="$(python3 - <<'PY'
print("c" * 1600)
PY
)"

run_prompt() {
  local prompt="$1"
  local cmd_base="${BASE_CMD_RAW}"
  if [[ "${cmd_base}" != *"--session"* ]]; then
    cmd_base="${cmd_base} --session ${session_id}"
  fi
  if [[ "${cmd_base}" == *"{prompt_file}"* ]]; then
    local tmp
    tmp="$(mktemp)"
    printf "%s" "${prompt}" > "${tmp}"
    local cmd="${cmd_base//\{prompt_file\}/${tmp}}"
    bash -lc "${cmd}" >/dev/null
    rm -f "${tmp}"
  else
    bash -lc "${cmd_base}" <<<"${prompt}" >/dev/null
  fi
}

run_prompt "Compaction test 1: ${payload}"
run_prompt "Compaction test 2: ${payload}"
run_prompt "Compaction test 3: ${payload}"

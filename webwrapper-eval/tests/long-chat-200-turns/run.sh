#!/usr/bin/env bash
set -euo pipefail
if [[ "${RUN_STRESS:-}" != "1" ]]; then
  echo "RUN_STRESS not set; skipping." >&2
  exit 0
fi
BASE_CMD_RAW="${AGENT_CMD_BASE:-${AGENT_CMD:-opencode run -m glm-local/glm-4.7 --format json}}"
LOG_FILE="${EVIDENCE_DIR:-/tmp}/long-chat-200-turns.log"
cmd_base_first="${BASE_CMD_RAW}"
cmd_base_continue="${BASE_CMD_RAW}"
if [[ "${cmd_base_continue}" != *"--continue"* && "${cmd_base_continue}" != *" -c "* ]]; then
  cmd_base_continue="${cmd_base_continue} --continue"
fi
run_prompt() {
  local prompt="$1"
  local cmd_base="$2"
  if [[ "${cmd_base}" == *"{prompt_file}"* ]]; then
    local tmp
    tmp="$(mktemp)"
    printf "%s" "${prompt}" > "${tmp}"
    local cmd="${cmd_base//\{prompt_file\}/${tmp}}"
    bash -lc "${cmd}" >>"${LOG_FILE}" 2>&1
    rm -f "${tmp}"
  else
    bash -lc "${cmd_base}" <<<"${prompt}" >>"${LOG_FILE}" 2>&1
  fi
}
for i in $(seq 1 200); do
  if [[ "${i}" -eq 1 ]]; then
    run_prompt "Ping ${i}." "${cmd_base_first}"
  else
    run_prompt "Ping ${i}." "${cmd_base_continue}"
  fi
  if (( i % 10 == 0 )); then
    echo "progress: ${i}/200" >&2
  fi
done
run_prompt "Final ping." "${cmd_base_continue}"

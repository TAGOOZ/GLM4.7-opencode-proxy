#!/usr/bin/env bash
set -euo pipefail
if [[ "${RUN_STRESS:-}" != "1" ]]; then
  echo "RUN_STRESS not set; skipping." >&2
  exit 0
fi
BASE_CMD_RAW="${AGENT_CMD_BASE:-${AGENT_CMD:-opencode run -m glm-local/glm-4.7 --format json}}"
run_one() {
  local prompt="$1"
  if [[ "${BASE_CMD_RAW}" == *"{prompt_file}"* ]]; then
    local tmp
    tmp="$(mktemp)"
    printf "%s" "${prompt}" > "${tmp}"
    local cmd="${BASE_CMD_RAW//\{prompt_file\}/${tmp}}"
    bash -lc "${cmd}" >/dev/null
    rm -f "${tmp}"
  else
    bash -lc "${BASE_CMD_RAW}" <<<"${prompt}" >/dev/null
  fi
}

export -f run_one
export BASE_CMD_RAW
seq 1 15 | xargs -I{} -P 10 bash -lc 'run_one "/test no-heuristics\nReturn only this exact text: PARALLEL_OK_{}"'

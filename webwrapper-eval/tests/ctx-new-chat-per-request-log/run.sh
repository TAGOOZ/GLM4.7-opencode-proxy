#!/usr/bin/env bash
set -euo pipefail
BASE_CMD_RAW="${AGENT_CMD_BASE:-${AGENT_CMD:-opencode run -m glm-local/glm-4.7 --format json}}"
run_once() {
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
run_once "Ping one"
run_once "Ping two"

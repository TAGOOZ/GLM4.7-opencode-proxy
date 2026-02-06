#!/usr/bin/env bash
set -euo pipefail
if [[ "${RUN_PERF:-}" != "1" ]]; then
  echo "RUN_PERF not set; skipping." >&2
  exit 0
fi
BASE_CMD_RAW="${AGENT_CMD_BASE:-${AGENT_CMD:-opencode run -m glm-local/glm-4.7 --format json}}"
concurrency="${PERF_CONCURRENCY:-10}"
requests="${PERF_REQUESTS:-20}"
timeout_sec="${PERF_TIMEOUT_SEC:-60}"
run_one() {
  local prompt="$1"
  if [[ "${BASE_CMD_RAW}" == *"{prompt_file}"* ]]; then
    local tmp
    tmp="$(mktemp)"
    printf "%s" "${prompt}" > "${tmp}"
    local cmd="${BASE_CMD_RAW//\{prompt_file\}/${tmp}}"
    if ! timeout "${timeout_sec}" bash -lc "${cmd}" >/dev/null; then
      echo "fail" >> "${EVIDENCE_DIR}/perf_concurrency_failures.txt"
    fi
    rm -f "${tmp}"
  else
    if ! timeout "${timeout_sec}" bash -lc "${BASE_CMD_RAW}" <<<"${prompt}" >/dev/null; then
      echo "fail" >> "${EVIDENCE_DIR}/perf_concurrency_failures.txt"
    fi
  fi
}
export -f run_one
export BASE_CMD_RAW
: > "${EVIDENCE_DIR}/perf_concurrency_failures.txt"
seq 1 "${requests}" | xargs -I{} -P "${concurrency}" bash -lc 'run_one "Parallel ping {}"'

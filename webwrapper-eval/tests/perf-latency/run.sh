#!/usr/bin/env bash
set -euo pipefail
if [[ "${RUN_PERF:-}" != "1" ]]; then
  echo "RUN_PERF not set; skipping." >&2
  exit 0
fi
BASE_CMD_RAW="${AGENT_CMD_BASE:-${AGENT_CMD:-opencode run -m glm-local/glm-4.7 --format json}}"
iterations="${PERF_ITERATIONS:-15}"
timeout_sec="${PERF_TIMEOUT_SEC:-60}"
output="${EVIDENCE_DIR}/perf_latency.csv"
: > "${output}"
for i in $(seq 1 "${iterations}"); do
  start=$(date +%s%3N)
  if [[ "${BASE_CMD_RAW}" == *"{prompt_file}"* ]]; then
    tmp="$(mktemp)"
    printf "%s" "Ping ${i}" > "${tmp}"
    cmd="${BASE_CMD_RAW//\{prompt_file\}/${tmp}}"
    if ! timeout "${timeout_sec}" bash -lc "${cmd}" >/dev/null; then
      echo "perf-latency timeout at iteration ${i}" >&2
      exit 1
    fi
    rm -f "${tmp}"
  else
    if ! timeout "${timeout_sec}" bash -lc "${BASE_CMD_RAW}" <<<"Ping ${i}" >/dev/null; then
      echo "perf-latency timeout at iteration ${i}" >&2
      exit 1
    fi
  fi
  end=$(date +%s%3N)
  echo "$((end - start))" >> "${output}"
  sleep 0.2
done

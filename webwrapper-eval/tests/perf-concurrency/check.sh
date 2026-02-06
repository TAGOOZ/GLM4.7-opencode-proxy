#!/usr/bin/env bash
set -euo pipefail
if [[ "${RUN_PERF:-}" != "1" ]]; then
  echo "RUN_PERF not set; skipping." >&2
  exit 3
fi
source ../../lib/common.sh
require_agent_success
file="${EVIDENCE_DIR}/perf_concurrency_failures.txt"
if [[ ! -f "${file}" ]]; then
  echo "missing failure log" >&2
  exit 1
fi
fails=$(grep -c "fail" "${file}" || true)
max_fail="${PERF_MAX_FAILS:-0}"
if [[ "${fails}" -gt "${max_fail}" ]]; then
  echo "failures ${fails} exceed ${max_fail}" >&2
  exit 1
fi
exit 0

#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh

if ! require_log_file; then
  exit 3
fi

require_agent_success
json_file="$(require_response_json)"
python3 ../../lib/assert_response.py "${json_file}" content_nonempty
python3 ../../lib/assert_response.py "${json_file}" content_contains "SUM="

sum_file="../../tmp/agentic-task-execution/sum.txt"
[[ -f "${sum_file}" ]] || { echo "missing ${sum_file}" >&2; exit 1; }
sum_val="$(tr -d '[:space:]' < "${sum_file}")"
if [[ "${sum_val}" != "31" ]]; then
  echo "expected sum 31, got ${sum_val}" >&2
  exit 1
fi

log_contains 'trace_span:.*"span":"request_total"' || { echo "missing request_total span" >&2; exit 1; }
log_contains 'trace_span:.*"span":"glm_collect_response"' || { echo "missing glm_collect_response span" >&2; exit 1; }
log_contains 'trace_span:.*"span":"guard_validate_tool_calls"' || { echo "missing guard_validate_tool_calls span" >&2; exit 1; }

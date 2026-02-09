#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh

if ! require_log_file; then
  exit 3
fi

require_agent_success
json_file="$(require_response_json)"
python3 ../../lib/assert_response.py "${json_file}" content_nonempty
python3 ../../lib/assert_response.py "${json_file}" content_contains "service-ready"

root="../../tmp/agentic-node-mini-project"
pkg="${root}/package.json"
idx="${root}/index.js"
[[ -f "${pkg}" ]] || { echo "missing ${pkg}" >&2; exit 1; }
[[ -f "${idx}" ]] || { echo "missing ${idx}" >&2; exit 1; }

grep -Fq '"agentic-node-mini-project"' "${pkg}" || { echo "package name missing" >&2; exit 1; }
grep -Fq '"start"' "${pkg}" || { echo "start script missing" >&2; exit 1; }
grep -Fq "service-ready" "${idx}" || { echo "index.js missing service-ready" >&2; exit 1; }

log_contains 'trace_span:.*"span":"request_total"' || { echo "missing request_total span" >&2; exit 1; }
log_contains 'trace_span:.*"span":"glm_collect_response"' || { echo "missing glm_collect_response span" >&2; exit 1; }
log_contains 'trace_span:.*"span":"guard_validate_tool_calls"' || { echo "missing guard_validate_tool_calls span" >&2; exit 1; }

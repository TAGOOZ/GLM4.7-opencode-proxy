#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh

if ! require_log_file; then
  exit 3
fi

require_agent_success
json_file="$(require_response_json)"
python3 ../../lib/assert_response.py "${json_file}" content_nonempty
python3 ../../lib/assert_response.py "${json_file}" content_contains "agentic-ok"

root="../../tmp/agentic-project-scaffold"
readme="${root}/README.md"
req="${root}/requirements.txt"
main_py="${root}/src/main.py"

[[ -f "${readme}" ]] || { echo "missing ${readme}" >&2; exit 1; }
[[ -f "${req}" ]] || { echo "missing ${req}" >&2; exit 1; }
[[ -f "${main_py}" ]] || { echo "missing ${main_py}" >&2; exit 1; }

grep -Fq "# Agentic Demo" "${readme}" || { echo "README missing title" >&2; exit 1; }
grep -Fxq "click==8.1.7" "${req}" || { echo "requirements mismatch" >&2; exit 1; }
grep -Fq "agentic-ok" "${main_py}" || { echo "main.py missing output" >&2; exit 1; }

log_contains 'trace_span:.*"span":"request_total"' || { echo "missing request_total span" >&2; exit 1; }
log_contains 'trace_span:.*"span":"prepare_chat_request"' || { echo "missing prepare_chat_request span" >&2; exit 1; }
log_contains 'trace_span:.*"span":"glm_collect_response"' || { echo "missing glm_collect_response span" >&2; exit 1; }
log_contains 'trace_span:.*"span":"guard_validate_tool_calls"' || { echo "missing guard_validate_tool_calls span" >&2; exit 1; }

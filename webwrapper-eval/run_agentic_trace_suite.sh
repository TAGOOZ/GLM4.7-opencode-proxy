#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVIDENCE_DIR="${ROOT_DIR}/evidence"
mkdir -p "${EVIDENCE_DIR}"

if [[ -z "${PROXY_LOG_FILE:-}" || ! -f "${PROXY_LOG_FILE}" ]]; then
  echo "Set PROXY_LOG_FILE to a running proxy log file, e.g. /tmp/proxy.log"
  exit 2
fi

if [[ -z "${AGENT_CMD:-}" ]]; then
  export AGENT_CMD='opencode run -m glm-local/glm-4.7 --format json'
fi

start_offset="$(wc -c < "${PROXY_LOG_FILE}" | tr -d ' ')"
test_filter="${TEST_FILTER:-^agentic-}"

echo "Running agentic trace suite with filter: ${test_filter}"
TEST_FILTER="${test_filter}" AGENT_CMD="${AGENT_CMD}" "${ROOT_DIR}/run_all.sh"

json_out="${EVIDENCE_DIR}/agentic_trace_summary.json"
text_out="${EVIDENCE_DIR}/agentic_trace_summary.txt"

python3 "${ROOT_DIR}/lib/analyze_tracer.py" \
  --log "${PROXY_LOG_FILE}" \
  --offset "${start_offset}" \
  --json-out "${json_out}" \
  --text-out "${text_out}"

echo ""
echo "Tracer reports:"
echo "  - ${text_out}"
echo "  - ${json_out}"

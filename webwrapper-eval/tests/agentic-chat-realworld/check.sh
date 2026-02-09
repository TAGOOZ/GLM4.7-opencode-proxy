#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh

if ! require_log_file; then
  exit 3
fi

require_agent_success
json_file="$(require_response_json)"
python3 ../../lib/assert_response.py "${json_file}" content_nonempty

python3 - "${json_file}" <<'PY'
import json
import sys
data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
content = (data.get("content") or "").lower()
if "ssd" not in content:
    raise SystemExit("missing SSD keyword")
if "hdd" not in content:
    raise SystemExit("missing HDD keyword")
PY

log_contains 'trace_span:.*"span":"request_total"' || { echo "missing request_total span" >&2; exit 1; }
log_contains 'trace_span:.*"span":"prepare_chat_request"' || { echo "missing prepare_chat_request span" >&2; exit 1; }
log_contains 'trace_span:.*"span":"glm_collect_response"' || { echo "missing glm_collect_response span" >&2; exit 1; }

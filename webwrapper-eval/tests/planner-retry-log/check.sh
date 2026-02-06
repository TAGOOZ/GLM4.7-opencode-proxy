#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh
if [[ "${PROXY_DEBUG:-}" != "1" ]]; then
  echo "PROXY_DEBUG not set; skipping." >&2
  exit 3
fi
if [[ "${PROXY_PLANNER_MAX_RETRIES:-0}" -lt 1 ]]; then
  echo "PROXY_PLANNER_MAX_RETRIES < 1; skipping." >&2
  exit 3
fi
if ! require_log_file; then
  exit 3
fi
if log_contains "model_retry_raw"; then
  exit 0
fi
echo "retry log not found" >&2
exit 1

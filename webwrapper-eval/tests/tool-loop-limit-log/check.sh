#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh
if [[ "${PROXY_DEBUG:-}" != "1" ]]; then
  echo "PROXY_DEBUG not set; skipping." >&2
  exit 3
fi
if [[ "${PROXY_TEST_MODE:-}" != "1" ]]; then
  echo "PROXY_TEST_MODE not set; skipping." >&2
  exit 3
fi
if [[ "${PROXY_TOOL_LOOP_LIMIT:-0}" -lt 1 ]]; then
  echo "PROXY_TOOL_LOOP_LIMIT < 1; skipping." >&2
  exit 3
fi
if ! require_log_file; then
  exit 3
fi
if log_contains "tool_loop_limit: true"; then
  exit 0
fi
echo "tool loop limit not observed" >&2
exit 1

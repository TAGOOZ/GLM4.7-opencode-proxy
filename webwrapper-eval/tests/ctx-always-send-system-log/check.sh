#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh
if [[ "${PROXY_DEBUG:-}" != "1" ]]; then
  echo "PROXY_DEBUG not set; skipping." >&2
  exit 3
fi
if [[ "${PROXY_ALWAYS_SEND_SYSTEM:-}" != "1" ]]; then
  echo "PROXY_ALWAYS_SEND_SYSTEM not set; skipping." >&2
  exit 3
fi
if [[ "${PROXY_USE_GLM_HISTORY:-}" != "1" ]]; then
  echo "PROXY_USE_GLM_HISTORY not set; skipping." >&2
  exit 3
fi
if [[ "${PROXY_TEST_MODE:-}" != "1" ]]; then
  echo "PROXY_TEST_MODE not set; skipping." >&2
  exit 3
fi
if ! require_log_file; then
  exit 3
fi
if log_contains "system_injected: true"; then
  exit 0
fi
echo "system injection not observed in proxy log" >&2
exit 1

#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh
if [[ "${PROXY_DEBUG:-}" != "1" ]]; then
  echo "PROXY_DEBUG not set; skipping." >&2
  exit 3
fi
if [[ "${PROXY_NEW_CHAT_PER_REQUEST:-}" != "1" ]]; then
  echo "PROXY_NEW_CHAT_PER_REQUEST not set; skipping." >&2
  exit 3
fi
source ../../lib/common.sh
require_agent_success
if ! require_log_file; then
  exit 3
fi
count=$(read_log_since_offset | grep -c "proxy_debug new_chat:" || true)
if [[ "${count}" -ge 2 ]]; then
  exit 0
fi
echo "expected at least 2 new_chat logs, got ${count}" >&2
exit 1

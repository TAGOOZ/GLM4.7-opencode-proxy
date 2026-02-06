#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh
if [[ "${RUN_COMPACTION:-}" != "1" ]]; then
  echo "RUN_COMPACTION not set; skipping." >&2
  exit 3
fi
if [[ "${PROXY_DEBUG:-}" != "1" ]]; then
  echo "PROXY_DEBUG not set; skipping." >&2
  exit 3
fi
if ! require_log_file; then
  exit 3
fi
if ! log_contains "compaction_reset: true"; then
  echo "compaction reset not observed in proxy log" >&2
  exit 1
fi
if ! log_contains "\"summaryAdded\":false"; then
  echo "summary unexpectedly present in compaction stats" >&2
  exit 1
fi
if ! log_contains "\"droppedMessages\":[1-9]"; then
  echo "dropped messages not observed in compaction stats" >&2
  exit 1
fi

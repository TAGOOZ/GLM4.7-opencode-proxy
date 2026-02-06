#!/usr/bin/env bash
set -euo pipefail
if [[ "${RUN_STRESS:-}" != "1" ]]; then
  echo "RUN_STRESS not set; skipping." >&2
  exit 3
fi
source ../../lib/common.sh
require_agent_success
exit 0

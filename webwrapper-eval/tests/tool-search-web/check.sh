#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh
json_file="$(require_response_json)"
if python3 ../../lib/assert_response.py "${json_file}" has_tool_call "webfetch,web_fetch,websearch,web_search"; then
  exit 0
fi
if python3 ../../lib/assert_response.py "${json_file}" content_contains "Hacker News"; then
  exit 0
fi
if [[ "${PROXY_ALLOW_WEB_SEARCH:-}" != "1" ]]; then
  echo "PROXY_ALLOW_WEB_SEARCH not enabled; skipping" >&2
  exit 3
fi
echo "web search output missing" >&2
exit 1

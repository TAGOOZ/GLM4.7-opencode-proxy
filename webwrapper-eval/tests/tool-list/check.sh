#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh
json_file="$(require_response_json)"
if python3 ../../lib/assert_response.py "${json_file}" has_tool_call "glob,list,list_dir"; then
  exit 0
fi
python3 ../../lib/assert_response.py "${json_file}" content_contains "run_all.sh"

#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh
json_file="$(require_response_json)"
python3 ../../lib/assert_response.py "${json_file}" has_tool_call "read,read_file,readfile,readFile"

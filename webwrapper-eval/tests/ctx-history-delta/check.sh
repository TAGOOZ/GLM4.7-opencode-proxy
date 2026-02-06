#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh
json_file="$(require_response_json)"
python3 ../../lib/assert_response.py "${json_file}" content_nonempty

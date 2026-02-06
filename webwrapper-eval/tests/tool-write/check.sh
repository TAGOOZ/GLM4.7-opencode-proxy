#!/usr/bin/env bash
set -euo pipefail
source ../../lib/common.sh
json_file="$(require_response_json)"
python3 ../../lib/assert_response.py "${json_file}" content_nonempty
file="../../tmp/tool-write/hello.txt"
if [[ ! -f "${file}" ]]; then
  echo "expected file not created" >&2
  exit 1
fi
content="$(cat "${file}")"
if [[ "${content}" != "hello-from-tool" ]]; then
  echo "unexpected file content: ${content}" >&2
  exit 1
fi

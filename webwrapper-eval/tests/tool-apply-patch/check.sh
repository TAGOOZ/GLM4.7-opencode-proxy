#!/usr/bin/env bash
set -euo pipefail
file="../../tmp/tool-apply-patch/notes.txt"
if [[ ! -f "${file}" ]]; then
  echo "expected file missing" >&2
  exit 1
fi
content="$(cat "${file}")"
if [[ "${content}" != "beta" ]]; then
  echo "patch did not apply" >&2
  exit 1
fi

#!/usr/bin/env bash
set -euo pipefail
file="../../tmp/tool-edit/notes.txt"
if [[ ! -f "${file}" ]]; then
  echo "expected file missing" >&2
  exit 1
fi
content="$(cat "${file}")"
if [[ "${content}" != "beta" ]]; then
  echo "edit did not apply" >&2
  exit 1
fi

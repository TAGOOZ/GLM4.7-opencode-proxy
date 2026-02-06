#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${STDOUT_FILE:-}" || ! -f "${STDOUT_FILE}" ]]; then
  echo "STDOUT_FILE missing" >&2
  exit 1
fi
if ! grep -q "^data:" "${STDOUT_FILE}"; then
  echo "streaming not detected" >&2
  exit 3
fi
if grep -q "\"usage\"" "${STDOUT_FILE}"; then
  exit 0
fi
echo "usage not found in stream" >&2
exit 1

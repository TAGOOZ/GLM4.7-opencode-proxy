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
if grep -q "reasoning_content" "${STDOUT_FILE}"; then
  echo "reasoning_content found with /thinking off" >&2
  exit 1
fi
exit 0

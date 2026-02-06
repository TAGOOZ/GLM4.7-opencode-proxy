#!/usr/bin/env bash
set -euo pipefail
file="../../tmp/large-diff/large.txt"
if [[ ! -f "${file}" ]]; then
  echo "expected file missing" >&2
  exit 1
fi
if ! head -n 1 "${file}" | grep -q "updated"; then
  echo "large diff did not apply" >&2
  exit 1
fi

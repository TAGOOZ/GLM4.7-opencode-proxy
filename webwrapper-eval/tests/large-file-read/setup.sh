#!/usr/bin/env bash
set -euo pipefail
mkdir -p ../../tmp/large-file-read
python3 - <<'PY'
with open('../../tmp/large-file-read/large.txt', 'w', encoding='utf-8') as f:
    for i in range(1, 12000):
        f.write(f"line {i}\n")
PY

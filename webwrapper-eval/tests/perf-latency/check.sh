#!/usr/bin/env bash
set -euo pipefail
if [[ "${RUN_PERF:-}" != "1" ]]; then
  echo "RUN_PERF not set; skipping." >&2
  exit 3
fi
source ../../lib/common.sh
require_agent_success
file="${EVIDENCE_DIR}/perf_latency.csv"
if [[ ! -f "${file}" ]]; then
  echo "missing perf output" >&2
  exit 1
fi
python3 - "${file}" "${PERF_MAX_AVG_MS:-}" "${PERF_MAX_P95_MS:-}" <<'PY'
import statistics
import sys

path = sys.argv[1]
values = [int(x.strip()) for x in open(path) if x.strip().isdigit()]
if not values:
    raise SystemExit("no values")
values.sort()
avg = sum(values) / len(values)
idx = int(round(0.95 * (len(values) - 1)))
p95 = values[idx]
print(f"avg_ms={avg:.1f} p95_ms={p95} count={len(values)}")
max_avg = float(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None
max_p95 = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None
if max_avg is not None and avg > max_avg:
    raise SystemExit(f"avg_ms {avg:.1f} exceeds {max_avg}")
if max_p95 is not None and p95 > max_p95:
    raise SystemExit(f"p95_ms {p95} exceeds {max_p95}")
PY
PYCODE=$?
exit ${PYCODE}

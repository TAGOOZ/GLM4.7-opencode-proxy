#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-off}" # off|on
PORT="${2:-}"
OUT_JSON="${3:-webwrapper-eval/evidence/ab_${MODE}.json}"
ROOT_DIR="${4:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

mkdir -p "$(dirname "$OUT_JSON")"
PROXY_LOG="/tmp/proxy_ab_${PORT}_${MODE}_$$.log"

if [[ "${MODE}" != "off" && "${MODE}" != "on" ]]; then
  echo "MODE must be 'off' or 'on'" >&2
  exit 2
fi

detect_opencode_port() {
  local config_path="${ROOT_DIR}/opencode.json"
  if [[ ! -f "${config_path}" ]]; then
    echo "8787"
    return 0
  fi
  python3 - "${config_path}" <<'PY'
import json
import re
import sys

path = sys.argv[1]
try:
  cfg = json.load(open(path, "r", encoding="utf-8"))
except Exception:
  print("8787")
  raise SystemExit(0)
providers = cfg.get("provider") if isinstance(cfg, dict) else {}
if not isinstance(providers, dict):
  print("8787")
  raise SystemExit(0)
for entry in providers.values():
  if not isinstance(entry, dict):
    continue
  options = entry.get("options")
  if not isinstance(options, dict):
    continue
  base = options.get("baseURL")
  if not isinstance(base, str):
    continue
  m = re.search(r":(\d+)", base)
  if m:
    print(m.group(1))
    raise SystemExit(0)
print("8787")
PY
}

CONFIG_PORT="$(detect_opencode_port)"
if [[ -z "${PORT}" ]]; then
  PORT="${CONFIG_PORT}"
fi
if [[ "${PORT}" != "${CONFIG_PORT}" ]]; then
  echo "Requested PORT=${PORT} but opencode.json baseURL uses port ${CONFIG_PORT}. Use PORT=${CONFIG_PORT} or update ${ROOT_DIR}/opencode.json." >&2
  exit 2
fi

cleanup() {
  if [[ -n "${PROXY_PID:-}" ]]; then
    kill "${PROXY_PID}" >/dev/null 2>&1 || true
    wait "${PROXY_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

export PROXY_DEBUG=1
export PROXY_USE_GLM_HISTORY=1
export PROXY_DEFAULT_THINKING=1
export PROXY_AUTO_CONFIRM=1
# Prefer stable OpenCode flows: don't inject extra reads in proxy (OpenCode enforces its own).
export PROXY_AUTO_READ_BEFORE_WRITE=0
# Bench mode: avoid human-confirmation stalls and prevent "helpful" networked installs
# that add noise and can dominate runtime. Prompts also instruct std-only projects.
export PROXY_CONFIRM_DANGEROUS_COMMANDS=0
export PROXY_ALLOW_NETWORK=0
export PROXY_REPAIR_WRITE_MISSING_PATH=1
export HOST=127.0.0.1
export PORT

( cd "${ROOT_DIR}" && npm --prefix ts_glm run start:proxy ) >"${PROXY_LOG}" 2>&1 &
PROXY_PID=$!

for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "${i}" -eq 90 ]]; then
    echo "proxy failed to start on port ${PORT}" >&2
    exit 2
  fi
done

scenario_prompt() {
  local scenario="$1"
  case "${scenario}" in
    snake)
      cat <<'EOF'
Create a Rust snake game project at webwrapper-eval/tmp/ab-snake.
Requirements:
1) Initialize cargo binary project.
2) Implement terminal snake gameplay in src/main.rs (simple loop, movement, food, collision).
3) Use Rust std only (no external crates in Cargo.toml).
4) Ensure code compiles.
5) Run: cargo check --manifest-path webwrapper-eval/tmp/ab-snake/Cargo.toml
6) End with one line exactly: BENCH_OK snake
EOF
      ;;
    calculator)
      cat <<'EOF'
Create a Rust calculator project at webwrapper-eval/tmp/ab-calculator.
Requirements:
1) Initialize cargo binary project.
2) Implement a CLI calculator supporting + - * / from command args.
3) MUST be CLI only (no WASM, no wasm-bindgen, no HTML, no web UI).
4) Use Rust std only (no external crates in Cargo.toml).
5) Print usage on invalid input.
6) Ensure src/main.rs contains a fn main() entrypoint.
7) Run: cargo check --manifest-path webwrapper-eval/tmp/ab-calculator/Cargo.toml
8) If cargo check fails, fix the code and rerun cargo check until it passes.
9) End with one line exactly: BENCH_OK calculator
EOF
      ;;
    tictactoe)
      cat <<'EOF'
Create a Rust tic-tac-toe project at webwrapper-eval/tmp/ab-tictactoe.
Requirements:
1) Initialize cargo binary project.
2) Implement two-player terminal tic-tac-toe logic in src/main.rs.
3) Use Rust std only (no external crates in Cargo.toml).
4) Validate moves and detect win/draw.
5) Run: cargo check --manifest-path webwrapper-eval/tmp/ab-tictactoe/Cargo.toml
6) End with one line exactly: BENCH_OK tictactoe
EOF
      ;;
    *)
      return 1
      ;;
  esac
}

cleanup_case_workspace() {
  local scenario="$1"
  rm -rf "${ROOT_DIR}/webwrapper-eval/tmp/ab-${scenario}" || true
  rm -rf "${ROOT_DIR}/webwrapper-eval/ab-${scenario}" || true
}

find_manifest() {
  local scenario="$1"
  local candidates=(
    "${ROOT_DIR}/webwrapper-eval/tmp/ab-${scenario}/Cargo.toml"
    "${ROOT_DIR}/webwrapper-eval/ab-${scenario}/Cargo.toml"
  )
  for manifest in "${candidates[@]}"; do
    if [[ -f "${manifest}" ]]; then
      echo "${manifest}"
      return 0
    fi
  done
  local discovered
  discovered="$(find "${ROOT_DIR}/webwrapper-eval" -maxdepth 4 -type f -name Cargo.toml -path "*ab-${scenario}*" 2>/dev/null | head -n1 || true)"
  if [[ -n "${discovered}" && -f "${discovered}" ]]; then
    echo "${discovered}"
    return 0
  fi
  return 1
}

run_case() {
  local scenario="$1"
  local idx="$2"
  local run_dir="${ROOT_DIR}/webwrapper-eval/evidence/ab_${MODE}_${scenario}_${idx}"
  mkdir -p "${run_dir}"
  cleanup_case_workspace "${scenario}"
  local prompt_file="${run_dir}/prompt.txt"
  scenario_prompt "${scenario}" > "${prompt_file}"
  if [[ "${MODE}" == "off" ]]; then
    printf '/thinking off\n\n' | cat - "${prompt_file}" > "${run_dir}/prompt_final.txt"
  else
    printf '/thinking on\n\n' | cat - "${prompt_file}" > "${run_dir}/prompt_final.txt"
  fi

  local start_off
  start_off="$(wc -c < "${PROXY_LOG}" | tr -d ' ')"

  set +e
  (cd "${ROOT_DIR}" && timeout "${AB_CASE_TIMEOUT:-900}" opencode run -m glm-local/glm-4.7 --format json < "${run_dir}/prompt_final.txt") > "${run_dir}/response.json" 2> "${run_dir}/stderr.log"
  local status=$?
  set -e

  local compile_status=98
  local manifest=""
  if manifest="$(find_manifest "${scenario}")"; then
    set +e
    cargo check --manifest-path "${manifest}" > "${run_dir}/cargo_check.log" 2>&1
    compile_status=$?
    set -e
  fi

  python3 - "${run_dir}/response.json" "${scenario}" "${status}" "${compile_status}" "${PROXY_LOG}" "${start_off}" "${manifest}" <<'PY'
import json
import re
import sys
from pathlib import Path

resp_path, scenario, status, compile_status, log_path, start_off, manifest = sys.argv[1:8]
status = int(status)
compile_status = int(compile_status)
start_off = int(start_off)

out = {
  "scenario": scenario,
  "status": status,
  "compile_status": compile_status,
  "manifest": manifest or None,
  "bench_ok": False,
  "tool_calls": 0,
  "agent_error": None,
  "first_request_id": None,
  "first_request_guard_calls": 0,
  "no_tool_first_turn": None,
}

def parse_response(path: str):
  content_parts = []
  tool_calls = 0
  agent_error = None
  saw_json_line = False
  openai_last = None
  for raw in Path(path).read_text(encoding="utf-8", errors="ignore").splitlines():
    line = raw.strip()
    if not line:
      continue
    if line.startswith("data:"):
      line = line[5:].strip()
      if line == "[DONE]":
        continue
    try:
      obj = json.loads(line)
    except Exception:
      continue
    saw_json_line = True
    if isinstance(obj, dict) and "choices" in obj:
      openai_last = obj
    if not isinstance(obj, dict):
      continue
    etype = obj.get("type")
    part = obj.get("part") or {}
    if etype == "error":
      err = obj.get("error") or {}
      data = err.get("data") if isinstance(err, dict) else {}
      msg = data.get("message") if isinstance(data, dict) else None
      if isinstance(msg, str) and msg.strip():
        agent_error = msg.strip()
      else:
        agent_error = "unknown opencode error"
    if etype == "text":
      text_val = part.get("text")
      if isinstance(text_val, str) and text_val:
        content_parts.append(text_val)
    if etype == "tool_use":
      tool_calls += 1
  if openai_last and isinstance(openai_last, dict):
    msg = {}
    choices = openai_last.get("choices") or []
    if choices and isinstance(choices[0], dict):
      msg = choices[0].get("message") or {}
    content = msg.get("content") if isinstance(msg, dict) else ""
    calls = msg.get("tool_calls") if isinstance(msg, dict) else []
    return (content if isinstance(content, str) else ""), (len(calls) if isinstance(calls, list) else 0), agent_error
  if saw_json_line:
    return "\n".join(content_parts).strip(), tool_calls, agent_error
  return "", 0, agent_error

content, tool_calls, agent_error = parse_response(resp_path)
out["tool_calls"] = tool_calls
out["bench_ok"] = f"BENCH_OK {scenario}" in content
out["agent_error"] = agent_error

trace_re = re.compile(r'trace_span:\s*(\{.*\})\s*$')
raw_log = Path(log_path).read_bytes()
seg = raw_log[start_off:].decode("utf-8", "ignore") if start_off < len(raw_log) else ""

first_request_id = None
guard_count = 0
for line in seg.splitlines():
  m = trace_re.search(line)
  if not m:
    continue
  try:
    span = json.loads(m.group(1))
  except Exception:
    continue
  name = span.get("span")
  if name == "prepare_chat_request" and first_request_id is None:
    rid = span.get("requestId")
    if isinstance(rid, str):
      first_request_id = rid
      continue
  if first_request_id is None:
    continue
  if name == "guard_validate_tool_calls" and span.get("requestId") == first_request_id:
    guard_count += 1
  if name == "request_total" and span.get("requestId") == first_request_id:
    break

out["first_request_id"] = first_request_id
out["first_request_guard_calls"] = guard_count
out["no_tool_first_turn"] = (guard_count == 0) if first_request_id else None
print(json.dumps(out))
PY
}

tmp_metrics="$(mktemp)"
for rep in $(seq 1 "${AB_REPS:-1}"); do
  for scenario in snake calculator tictactoe; do
    run_case "${scenario}" "${rep}" >> "${tmp_metrics}"
  done
done

python3 - "${tmp_metrics}" "${OUT_JSON}" "${MODE}" <<'PY'
import json
import sys

metrics_path, out_path, mode = sys.argv[1:4]
cases = [json.loads(line) for line in open(metrics_path, "r", encoding="utf-8") if line.strip()]
valid = [c for c in cases if c.get("no_tool_first_turn") is not None]
first_total = len(valid)
no_tool = sum(1 for c in valid if c.get("no_tool_first_turn") is True)
rate = (no_tool / first_total) if first_total else 0.0
cases_ok = sum(
  1 for c in cases
  if c.get("status") == 0 and c.get("bench_ok") and c.get("compile_status") == 0
)

out = {
  "mode": mode,
  "cases_total": len(cases),
  "cases_ok": cases_ok,
  "first_requests": first_total,
  "no_tool_first_turn": no_tool,
  "no_tool_first_turn_rate": round(rate, 4),
  "cases": cases,
}
with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(out, fh, indent=2)
print(json.dumps(out, indent=2))
PY

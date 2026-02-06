#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${EVIDENCE_DIR:-}" ]]; then
  echo "EVIDENCE_DIR not set" >&2
  exit 1
fi

pick_source_file() {
  if [[ -n "${COMBINED_FILE:-}" && -f "${COMBINED_FILE}" ]]; then
    echo "${COMBINED_FILE}"
    return 0
  fi
  if [[ -n "${STDOUT_FILE:-}" && -f "${STDOUT_FILE}" ]]; then
    echo "${STDOUT_FILE}"
    return 0
  fi
  return 1
}

extract_response_json() {
  local out_path="$1"
  local src_file
  src_file="$(pick_source_file)"
  if [[ -z "${src_file}" ]]; then
    echo "No stdout/combined file found" >&2
    return 1
  fi
  python3 - "${src_file}" "${out_path}" <<'PY'
import json
import sys

src_file = sys.argv[1]
out_path = sys.argv[2]
text = open(src_file, "r", encoding="utf-8", errors="ignore").read()

def normalize_openai(obj):
    msg = {}
    choices = obj.get("choices") or []
    if choices and isinstance(choices[0], dict):
        msg = choices[0].get("message") or {}
    content = msg.get("content") if isinstance(msg, dict) else ""
    tool_calls = msg.get("tool_calls") if isinstance(msg, dict) else []
    return {
        "format": "openai",
        "content": content if isinstance(content, str) else "",
        "tool_calls": tool_calls if isinstance(tool_calls, list) else [],
        "usage": obj.get("usage"),
    }

def normalize_opencode(events):
    texts = []
    tool_calls = []
    tokens = None
    for evt in events:
        if not isinstance(evt, dict):
            continue
        etype = evt.get("type")
        part = evt.get("part") or {}
        if etype == "text":
            text_val = part.get("text")
            if isinstance(text_val, str) and text_val:
                texts.append(text_val)
        if etype == "tool_use":
            state = part.get("state") or {}
            tool_calls.append({
                "tool": part.get("tool") or part.get("toolName") or part.get("name"),
                "input": state.get("input"),
                "output": state.get("output"),
                "state": state,
            })
        if etype == "step_finish":
            if isinstance(part.get("tokens"), dict):
                tokens = part.get("tokens")
    return {
        "format": "opencode",
        "content": "\n".join(texts).strip(),
        "tool_calls": tool_calls,
        "tokens": tokens,
    }

events = []
openai_candidates = []

for line in text.splitlines():
    line = line.strip()
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
    if isinstance(obj, dict) and "choices" in obj:
        openai_candidates.append(obj)
    if isinstance(obj, dict) and obj.get("type"):
        events.append(obj)

if openai_candidates:
    normalized = normalize_openai(openai_candidates[-1])
else:
    if not events:
        # fallback: try parse entire text as JSON
        try:
            obj = json.loads(text)
        except Exception:
            sys.exit("NO_JSON_RESPONSE")
        if isinstance(obj, dict) and "choices" in obj:
            normalized = normalize_openai(obj)
        else:
            sys.exit("NO_JSON_RESPONSE")
    normalized = normalize_opencode(events)

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(normalized, f)

print(out_path)
PY
}

require_response_json() {
  local out_path="${EVIDENCE_DIR}/response.json"
  if ! extract_response_json "${out_path}" >/dev/null; then
    echo "Unable to locate JSON response in agent output." >&2
    return 1
  fi
  echo "${out_path}"
}

require_log_file() {
  if [[ -z "${PROXY_LOG_FILE:-}" || ! -f "${PROXY_LOG_FILE}" ]]; then
    echo "PROXY_LOG_FILE not set or missing; skipping." >&2
    return 3
  fi
  return 0
}

read_log_since_offset() {
  if ! require_log_file; then
    return 3
  fi
  local offset="${PROXY_LOG_OFFSET:-0}"
  if [[ "${offset}" -lt 0 ]]; then
    offset=0
  fi
  local start=$((offset + 1))
  tail -c "+${start}" "${PROXY_LOG_FILE}" 2>/dev/null || true
}

log_contains() {
  local pattern="$1"
  if ! require_log_file; then
    return 3
  fi
  if read_log_since_offset | grep -E -q "${pattern}"; then
    return 0
  fi
  return 1
}

require_agent_success() {
  local code_file="${EVIDENCE_DIR}/exit_code.txt"
  if [[ ! -f "${code_file}" ]]; then
    echo "exit_code.txt missing" >&2
    return 1
  fi
  local code
  code="$(cat "${code_file}" | tr -d '[:space:]')"
  if [[ "${code}" != "0" ]]; then
    echo "agent exited with ${code}" >&2
    return 1
  fi
  return 0
}

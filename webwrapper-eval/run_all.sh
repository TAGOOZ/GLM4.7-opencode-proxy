#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="${ROOT_DIR}/tests"
BASE_EVIDENCE_DIR="${ROOT_DIR}/evidence"

if [[ ! -d "${TESTS_DIR}" ]]; then
  echo "No tests directory found at ${TESTS_DIR}"
  exit 2
fi

if [[ -z "${AGENT_CMD:-}" ]]; then
  echo "Set AGENT_CMD to the agent-under-test command."
  echo "Example: AGENT_CMD='opencode run -m glm-local/glm-4.7 --format json'"
  exit 2
fi

mkdir -p "${BASE_EVIDENCE_DIR}"

total=0
passed=0
failed=0
skipped=0

echo "Running tests from ${TESTS_DIR}"
echo "Agent command: ${AGENT_CMD}"

for test_dir in "${TESTS_DIR}"/*; do
  [[ -d "${test_dir}" ]] || continue
  test_id="$(basename "${test_dir}")"
  if [[ -n "${TEST_FILTER:-}" ]]; then
    if [[ ! "${test_id}" =~ ${TEST_FILTER} ]]; then
      continue
    fi
  fi
  prompt_file="${test_dir}/prompt.txt"
  check_file="${test_dir}/check.sh"
  setup_file="${test_dir}/setup.sh"
  env_file="${test_dir}/env.sh"
  agent_cmd_file="${test_dir}/agent_cmd.txt"
  agent_cmd="${AGENT_CMD}"

  if [[ ! -f "${prompt_file}" ]]; then
    echo "[${test_id}] missing prompt.txt (skip)"
    skipped=$((skipped + 1))
    continue
  fi

  total=$((total + 1))
  evidence_test_dir="${BASE_EVIDENCE_DIR}/${test_id}"
  rm -rf "${evidence_test_dir}"
  mkdir -p "${evidence_test_dir}"

  stdout_file="${evidence_test_dir}/stdout.log"
  stderr_file="${evidence_test_dir}/stderr.log"
  combined_file="${evidence_test_dir}/combined.log"
  exit_code_file="${evidence_test_dir}/exit_code.txt"
  check_stdout="${evidence_test_dir}/check_stdout.log"
  check_stderr="${evidence_test_dir}/check_stderr.log"
  check_status_file="${evidence_test_dir}/check_status.txt"

  export PROMPT_FILE="${prompt_file}"
  export PROMPT_TEXT
  PROMPT_TEXT="$(cat "${prompt_file}")"
  export EVIDENCE_DIR="${evidence_test_dir}"
  export STDOUT_FILE="${stdout_file}"
  export STDERR_FILE="${stderr_file}"
  export COMBINED_FILE="${combined_file}"
  if [[ -n "${PROXY_LOG_FILE:-}" && -f "${PROXY_LOG_FILE}" ]]; then
    export PROXY_LOG_OFFSET
    PROXY_LOG_OFFSET="$(wc -c < "${PROXY_LOG_FILE}" | tr -d ' ')"
  else
    unset PROXY_LOG_OFFSET
  fi

  if [[ -f "${agent_cmd_file}" ]]; then
    agent_cmd="$(cat "${agent_cmd_file}")"
    if [[ "${agent_cmd}" == *"{AGENT_CMD}"* ]]; then
      agent_cmd="${agent_cmd//\{AGENT_CMD\}/${AGENT_CMD}}"
    fi
    if [[ "${agent_cmd}" == *"{test_dir}"* ]]; then
      agent_cmd="${agent_cmd//\{test_dir\}/${test_dir}}"
    fi
  fi

  if [[ -f "${setup_file}" ]]; then
    echo "[${test_id}] running setup.sh"
    (cd "${test_dir}" && bash "${setup_file}")
  fi

  echo "[${test_id}] running agent"
  set +e
  timeout_cmd=()
  if [[ -n "${TEST_TIMEOUT_SEC:-}" ]]; then
    timeout_cmd=(timeout "${TEST_TIMEOUT_SEC}")
  fi
  if [[ "${agent_cmd}" == *"{prompt_file}"* ]]; then
    cmd="${agent_cmd//\{prompt_file\}/${PROMPT_FILE}}"
    if [[ -f "${env_file}" ]]; then
      (set -a; source "${env_file}"; set +a; "${timeout_cmd[@]}" bash -lc "${cmd}") >"${stdout_file}" 2>"${stderr_file}"
    else
      "${timeout_cmd[@]}" bash -lc "${cmd}" >"${stdout_file}" 2>"${stderr_file}"
    fi
  else
    if [[ -f "${env_file}" ]]; then
      (set -a; source "${env_file}"; set +a; "${timeout_cmd[@]}" bash -lc "${agent_cmd}" <"${prompt_file}") >"${stdout_file}" 2>"${stderr_file}"
    else
      "${timeout_cmd[@]}" bash -lc "${agent_cmd}" <"${prompt_file}" >"${stdout_file}" 2>"${stderr_file}"
    fi
  fi
  agent_status=$?
  set -e
  echo "${agent_status}" >"${exit_code_file}"
  cat "${stdout_file}" "${stderr_file}" >"${combined_file}" 2>/dev/null || true

  if [[ ! -f "${check_file}" ]]; then
    echo "[${test_id}] missing check.sh (fail)"
    echo "1" >"${check_status_file}"
    failed=$((failed + 1))
    continue
  fi

  echo "[${test_id}] running check.sh"
  set +e
  (cd "${test_dir}" && bash "${check_file}") >"${check_stdout}" 2>"${check_stderr}"
  check_status=$?
  set -e
  echo "${check_status}" >"${check_status_file}"

  if [[ "${check_status}" -eq 0 ]]; then
    echo "[${test_id}] PASS"
    passed=$((passed + 1))
  elif [[ "${check_status}" -eq 3 ]]; then
    echo "[${test_id}] SKIP"
    skipped=$((skipped + 1))
  else
    echo "[${test_id}] FAIL"
    failed=$((failed + 1))
  fi
done

echo ""
echo "Summary"
echo "  total:   ${total}"
echo "  passed:  ${passed}"
echo "  failed:  ${failed}"
echo "  skipped: ${skipped}"

if [[ "${failed}" -ne 0 ]]; then
  exit 1
fi

exit 0

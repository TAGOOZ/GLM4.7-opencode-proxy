#!/bin/bash
# Helper script to work around opencode CLI -f flag parsing issues
# Usage: ./opencode-with-file.sh [options] -f <file> "<message>"
#
# This script reads file content and includes it in the prompt to work around
# the opencode run -f argument parsing bug where messages are treated as file paths.

set -e

USAGE="Usage: $0 [--format json] [-m model] [-f file] \"message\"

Options:
  --format FORMAT   Output format (json, text, etc.)
  -m MODEL         Model to use (default: glm-local/glm-4.7)
  -f FILE          File to attach (content will be embedded in prompt)
  --session ID     Session ID for continuing conversations

Examples:
  $0 -f sample.md \"Summarize this file\"
  $0 --format json -m glm-local/glm-4.7 -f data.txt \"Analyze this data\"
"

# Default values
FORMAT=""
MODEL="glm-local/glm-4.7"
FILE=""
SESSION=""
MESSAGE=""
ARG_MAX=$(getconf ARG_MAX 2>/dev/null || echo "")
PROMPT_MAX=""

if [ -n "$ARG_MAX" ]; then
  # Leave headroom for environment and other args; cap to ~50% of ARG_MAX
  PROMPT_MAX=$((ARG_MAX / 2))
else
  # Conservative fallback to avoid ARG_MAX errors on some systems
  PROMPT_MAX=$((256 * 1024))
fi

require_arg() {
  local opt="$1"
  local val="$2"
  if [ -z "$val" ] || [[ "$val" == -* ]]; then
    echo "Error: $opt requires an argument." >&2
    echo "$USAGE" >&2
    exit 1
  fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --format)
      require_arg --format "$2"
      FORMAT="$2"
      shift 2
      ;;
    -m)
      require_arg -m "$2"
      MODEL="$2"
      shift 2
      ;;
    -f)
      require_arg -f "$2"
      FILE="$2"
      shift 2
      ;;
    --session)
      require_arg --session "$2"
      SESSION="$2"
      shift 2
      ;;
    --)
      shift
      if [ $# -gt 0 ]; then
        MESSAGE="$*"
      fi
      break
      ;;
    -h|--help)
      echo "$USAGE"
      exit 0
      ;;
    *)
      # Treat remaining args as the message (supports unquoted multi-word prompts)
      MESSAGE="$*"
      break
      ;;
  esac
done

# Validate inputs
if [ -z "$MESSAGE" ]; then
  echo "Error: Message is required" >&2
  echo "$USAGE" >&2
  exit 1
fi

if [ -n "$FILE" ] && [ ! -f "$FILE" ]; then
  echo "Error: File not found: $FILE" >&2
  exit 1
fi

# Check file size (limit to 1MB or ARG_MAX-derived cap for safety)
if [ -n "$FILE" ]; then
  # Try BSD stat (macOS, FreeBSD: -f%z) then GNU stat (Linux: -c%s)
  FILE_SIZE=$(stat -f%z "$FILE" 2>/dev/null || stat -c%s "$FILE" 2>/dev/null || echo "")
  if [ -z "$FILE_SIZE" ]; then
    echo "Warning: Could not determine file size for $FILE. Proceeding without size check." >&2
  else
    MAX_SIZE=$((1024 * 1024))  # 1MB default
    if [ "$PROMPT_MAX" -gt 0 ] && [ "$PROMPT_MAX" -lt "$MAX_SIZE" ]; then
      MAX_SIZE="$PROMPT_MAX"
    fi
    if [ "$FILE_SIZE" -gt "$MAX_SIZE" ]; then
      FILE_SIZE_KB=$((FILE_SIZE / 1024))
      MAX_SIZE_KB=$((MAX_SIZE / 1024))
      echo "Error: File too large: $FILE (${FILE_SIZE_KB}KB). Maximum size is ${MAX_SIZE_KB}KB." >&2
      exit 1
    fi
  fi
fi

# Build the prompt
if [ -n "$FILE" ]; then
  FILENAME=$(basename "$FILE")
  CONTENT=$(cat "$FILE")
  FULL_PROMPT=$(printf 'Attached file: %s\n\n```\n%s\n```\n\n%s' "$FILENAME" "$CONTENT" "$MESSAGE")
else
  FULL_PROMPT="$MESSAGE"
fi

# Final guard against argument length limits
if [ -n "$PROMPT_MAX" ]; then
  FULL_LEN=${#FULL_PROMPT}
  if [ "$FULL_LEN" -gt "$PROMPT_MAX" ]; then
    echo "Error: Prompt too large for CLI invocation (${FULL_LEN} bytes). Try a smaller file or use the API option in OPENCODE_USAGE.md." >&2
    exit 1
  fi
fi

# Build opencode command arguments
ARGS=()
[ -n "$FORMAT" ] && ARGS+=(--format "$FORMAT")
ARGS+=(-m "$MODEL")
[ -n "$SESSION" ] && ARGS+=(--session "$SESSION")
ARGS+=("$FULL_PROMPT")

# Execute
opencode run "${ARGS[@]}"

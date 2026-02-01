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

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --format)
      FORMAT="$2"
      shift 2
      ;;
    -m)
      MODEL="$2"
      shift 2
      ;;
    -f)
      FILE="$2"
      shift 2
      ;;
    --session)
      SESSION="$2"
      shift 2
      ;;
    -h|--help)
      echo "$USAGE"
      exit 0
      ;;
    *)
      # Assume remaining argument is the message
      MESSAGE="$1"
      shift
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

# Check file size (limit to 1MB for safety)
if [ -n "$FILE" ]; then
  # Try BSD stat (macOS, FreeBSD: -f%z) then GNU stat (Linux: -c%s)
  FILE_SIZE=$(stat -f%z "$FILE" 2>/dev/null || stat -c%s "$FILE" 2>/dev/null || echo "")
  if [ -z "$FILE_SIZE" ]; then
    echo "Warning: Could not determine file size for $FILE. Proceeding without size check." >&2
  else
    MAX_SIZE=$((1024 * 1024))  # 1MB
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
  FULL_PROMPT="Attached file: $FILENAME

\`\`\`
$CONTENT
\`\`\`

$MESSAGE"
else
  FULL_PROMPT="$MESSAGE"
fi

# Build opencode command arguments
ARGS=()
[ -n "$FORMAT" ] && ARGS+=(--format "$FORMAT")
ARGS+=(-m "$MODEL")
[ -n "$SESSION" ] && ARGS+=(--session "$SESSION")
ARGS+=("$FULL_PROMPT")

# Execute
opencode run "${ARGS[@]}"

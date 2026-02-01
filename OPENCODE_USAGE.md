# Using OpenCode with GLM 4.7 Proxy

This document provides guidance on using the OpenCode CLI with the GLM 4.7 proxy server.

## Setup

1. Install OpenCode CLI (if not already installed):
```bash
npm install -g @opencode-ai/opencode
```

2. Start the GLM proxy server:
```bash
# TypeScript proxy
cd ts_glm
npm run start:proxy

# OR Python proxy
source venv/bin/activate
python3 -m uvicorn glm_proxy.server:app --host 127.0.0.1 --port 8787
```

3. Ensure `opencode.json` in the root directory points to your local proxy (it should already be configured).

## Basic Usage

### Simple prompts
```bash
opencode run -m glm-local/glm-4.7 "Your prompt here"
```

### With format options
```bash
opencode run --format json -m glm-local/glm-4.7 "Your prompt"
```

## File Attachments - Known Issues & Workarounds

### Known Issue with `-f` Flag

The `opencode run -f <file> "message"` command has a known argument parsing issue in the OpenCode CLI (as of the time of this writing):

**Problem**: The message parameter is incorrectly parsed as a file path, causing errors like:
```
Error: File not found: Using the attached file only...
```

**Also affected**: Using `--` as a separator causes the command to hang with no output.

### Recommended Workarounds

#### Option 1: Use API directly with file content

Instead of relying on the CLI's file attachment feature, read the file content and include it in your prompt:

```bash
# Read file content and pass it in the prompt
FILE_CONTENT=$(cat examples/sample.md)
opencode run -m glm-local/glm-4.7 "Using the following file content, provide a 2-sentence summary and suggest one improvement:

\`\`\`
$FILE_CONTENT
\`\`\`"
```

#### Option 2: Use the proxy API directly

You can bypass the OpenCode CLI and call the proxy API directly using curl or your favorite HTTP client:

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.7",
    "messages": [
      {
        "role": "user", 
        "content": "Using the attached file content, provide a 2-sentence summary:\n\n'"$(cat sample.md)"'"
      }
    ]
  }'
```

#### Option 3: Use the included helper script

This repository includes a helper script `opencode-with-file.sh` that properly handles file attachments.

**Features:**
- Reads file content and embeds it in the prompt
- Validates file existence and size (max 1MB)
- Supports all opencode flags (--format, -m, --session, -f)
- Already has execute permissions set

**Usage:**

```bash
# Basic usage
./opencode-with-file.sh -f examples/sample.md "Provide a 2-sentence summary"

# With options
./opencode-with-file.sh --format json -m glm-local/glm-4.7 -f examples/sample.md "Analyze this file"

# With session ID
./opencode-with-file.sh --session ses_abc123 -f data.txt "Continue analyzing"

# Help
./opencode-with-file.sh --help
```

**Note**: The script already has execute permissions set in this repository.

## Testing the Proxy

To verify the proxy is working correctly:

```bash
# Test basic completion
opencode run -m glm-local/glm-4.7 "Say hello in one sentence"

# Test with format
opencode run --format json -m glm-local/glm-4.7 "What is 2+2?"
```

## Troubleshooting

### Proxy not responding
- Ensure the proxy server is running on port 8787
- Check that `opencode.json` has the correct `baseURL`: `http://127.0.0.1:8787/v1`
- Verify your GLM token is configured (see main README.md)

### Command hangs
- Avoid using `--` separator with file arguments until the OpenCode CLI bug is fixed
- Use one of the workarounds above instead

### File not found errors with `-f` flag
- This is a known issue in the OpenCode CLI's argument parser
- Use one of the workarounds above until the issue is fixed upstream

## Reporting Issues

- **Proxy issues**: File issues in this repository (GLM4.7-opencode-proxy)
- **OpenCode CLI issues**: File issues in the OpenCode repository
- **GLM API issues**: Contact the GLM team at chat.z.ai

## Additional Resources

- [OpenCode Documentation](https://opencode.ai/docs)
- [GLM Chat Interface](https://chat.z.ai)
- Main repository README: `README.md`

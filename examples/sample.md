# Sample Document for Testing

This is a sample document that can be used for testing file attachments with the GLM 4.7 proxy and OpenCode.

## Purpose

This document demonstrates how file content can be attached to prompts when using the OpenCode CLI with the local GLM proxy.

## Content

The document contains:
- Markdown formatting
- Multiple sections
- Sample text for analysis

## Use Cases

1. **Summarization**: Ask the model to summarize this document
2. **Analysis**: Request insights about the document structure
3. **Improvements**: Get suggestions for enhancing the content
4. **Q&A**: Ask questions about the document content

## Testing

Use this file with the `opencode-with-file.sh` helper script:

```bash
./opencode-with-file.sh -f examples/sample.md "Provide a 2-sentence summary"
```

Or read it manually and include in your prompt:

```bash
FILE_CONTENT=$(cat examples/sample.md)
opencode run -m glm-local/glm-4.7 "Summarize this: $FILE_CONTENT"
```

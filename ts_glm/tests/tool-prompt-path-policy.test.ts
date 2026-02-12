import test from "node:test";
import assert from "node:assert/strict";

import { buildToolPrompt } from "../src/proxy/messages/toolPrompt.js";

test("tool prompt includes explicit path and patch target guard guidance", () => {
  const prompt = buildToolPrompt(
    [
      {
        function: {
          name: "read",
          parameters: { properties: { path: { type: "string" } } },
        },
      },
      {
        function: {
          name: "apply_patch",
          parameters: { properties: { patch: { type: "string" } } },
        },
      },
    ] as any,
    [
      "Runtime workspace context:",
      "- cwd: /repo",
      "Never emit read/write/edit/apply_patch actions without an explicit file path.",
      "For apply_patch/patch, include explicit target file headers in patch text (*** Update File: ... or diff --git ...).",
    ].join("\n"),
  );

  assert.equal(
    prompt.includes("never emit read/write/edit/list/listdir actions without an explicit target path."),
    true,
  );
  assert.equal(
    prompt.includes("apply_patch/patch must include explicit target files in patch text"),
    true,
  );
  assert.equal(
    prompt.includes("do not emit apply_patch/patch without target file headers in the patch body."),
    true,
  );
  assert.equal(
    prompt.includes("avoid ~ and ../ traversal; absolute paths are allowed only when they stay inside workspace."),
    true,
  );
  assert.equal(
    prompt.includes("use the tool's declared path key exactly (path/filePath/file_path)."),
    true,
  );
  assert.equal(
    prompt.includes("For existing files, you MUST read the target file before any write/edit/apply_patch mutation."),
    true,
  );
});

test("tool prompt keeps both head and tail when extra system text is truncated", () => {
  const head = "HEAD_SENTINEL";
  const filler = "x".repeat(1200);
  const tail = "TAIL_SENTINEL";
  const prompt = buildToolPrompt(
    [
      {
        function: {
          name: "read",
          parameters: { properties: { path: { type: "string" } } },
        },
      },
    ] as any,
    `${head}\n${filler}\n${tail}`,
  );

  assert.equal(prompt.includes(head), true);
  assert.equal(prompt.includes(tail), true);
});

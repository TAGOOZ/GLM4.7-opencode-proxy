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
    prompt.includes("avoid absolute paths, ~, and ../ traversal; these trigger path guards."),
    true,
  );
  assert.equal(
    prompt.includes("use the tool's declared path key exactly (path/filePath/file_path)."),
    true,
  );
});

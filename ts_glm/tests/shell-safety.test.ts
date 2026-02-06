import test from "node:test";
import assert from "node:assert/strict";

import { isProxyShellCommandAllowed } from "../src/proxy/tools/shellSafety.js";

test("proxy shell safety blocks network by default", () => {
  assert.equal(isProxyShellCommandAllowed("curl https://example.com", false).ok, false);
  assert.equal(isProxyShellCommandAllowed("git clone https://example.com/repo.git", false).ok, false);
  assert.equal(isProxyShellCommandAllowed("npm install lodash", false).ok, false);
});

test("proxy shell safety enforces allowlist", () => {
  assert.equal(isProxyShellCommandAllowed("rg \"TODO\" .", false).ok, true);
  // Not allowlisted (even if not explicitly denylisted).
  assert.equal(isProxyShellCommandAllowed("rm foo.txt", false).ok, false);
});

test("proxy shell safety enforces denylist", () => {
  assert.equal(isProxyShellCommandAllowed("rm -rf /", true).ok, false);
  assert.equal(isProxyShellCommandAllowed("sudo whoami", true).ok, false);
});

test("proxy shell safety allows networked commands when explicitly enabled", () => {
  assert.equal(isProxyShellCommandAllowed("git clone https://example.com/repo.git", true).ok, true);
});


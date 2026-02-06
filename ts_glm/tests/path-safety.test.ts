import test from "node:test";
import assert from "node:assert/strict";
import { isSensitivePath, isUnsafePathInput } from "../src/proxy/tools/pathSafety.js";

test("isUnsafePathInput blocks absolute paths", () => {
  assert.equal(isUnsafePathInput("/etc/passwd"), true);
  assert.equal(isUnsafePathInput("C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts"), true);
  assert.equal(isUnsafePathInput("C:/Windows/System32/drivers/etc/hosts"), true);
  assert.equal(isUnsafePathInput("\\\\server\\\\share\\\\file.txt"), true);
  assert.equal(isUnsafePathInput("\\\\Windows\\\\System32"), true);
});

test("isSensitivePath avoids substring false positives like monkey/hockey", () => {
  assert.equal(isSensitivePath("src/monkey.ts"), false);
  assert.equal(isSensitivePath("src/hockey.js"), false);
  assert.equal(isSensitivePath("src/keyboard.ts"), false);
});

test("isSensitivePath allows common example env files", () => {
  assert.equal(isSensitivePath(".env.example"), false);
  assert.equal(isSensitivePath(".env.sample"), false);
  assert.equal(isSensitivePath(".env.template"), false);
  assert.equal(isSensitivePath(".env.dist"), false);
});

test("isSensitivePath still blocks high-signal secret paths", () => {
  assert.equal(isSensitivePath(".env"), true);
  assert.equal(isSensitivePath(".env.local"), true);
  assert.equal(isSensitivePath(".env.production"), true);
  assert.equal(isSensitivePath(".ssh/id_rsa"), true);
  assert.equal(isSensitivePath(".git/config"), true);
  assert.equal(isSensitivePath("config/api_key.txt"), true);
  assert.equal(isSensitivePath("config/private-key.pem"), true);
  assert.equal(isSensitivePath("config/creds_backup.txt"), true);
  assert.equal(isSensitivePath("config/credentials.json"), true);
  assert.equal(isSensitivePath(".gitignore"), false);
});

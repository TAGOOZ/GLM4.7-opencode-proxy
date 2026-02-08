import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSensitivePath,
  isUnsafePathInput,
  normalizePathForWorkspace,
} from "../src/proxy/tools/pathSafety.js";

test("isUnsafePathInput blocks absolute paths", () => {
  assert.equal(isUnsafePathInput("/etc/passwd"), true);
  assert.equal(isUnsafePathInput("C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts"), true);
  assert.equal(isUnsafePathInput("C:/Windows/System32/drivers/etc/hosts"), true);
  assert.equal(isUnsafePathInput("\\\\server\\\\share\\\\file.txt"), true);
  assert.equal(isUnsafePathInput("\\\\Windows\\\\System32"), true);
});

test("normalizePathForWorkspace converts in-workspace absolute path to relative", () => {
  const root = process.cwd();
  const absolute = `${root}/snake_game/Cargo.toml`;
  assert.equal(normalizePathForWorkspace(absolute, [root]), "snake_game/Cargo.toml");
});

test("isUnsafePathInput allows in-workspace absolute paths when enabled", () => {
  const root = process.cwd();
  const absolute = `${root}/snake_game/Cargo.toml`;
  assert.equal(
    isUnsafePathInput(absolute, { allowAbsoluteInWorkspace: true, workspaceRoots: [root] }),
    false,
  );
  assert.equal(
    isUnsafePathInput("/etc/passwd", { allowAbsoluteInWorkspace: true, workspaceRoots: [root] }),
    true,
  );
});

test("isUnsafePathInput rejects symlink escapes from workspace roots", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ts-glm-path-safety-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  const link = path.join(root, "link");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  try {
    fs.symlinkSync(outside, link, "dir");
  } catch {
    fs.rmSync(base, { recursive: true, force: true });
    return;
  }
  try {
    const escaped = path.join(link, "secret.txt");
    assert.equal(normalizePathForWorkspace(escaped, [root]), escaped);
    assert.equal(
      isUnsafePathInput(escaped, { allowAbsoluteInWorkspace: true, workspaceRoots: [root] }),
      true,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("isSensitivePath avoids substring false positives like monkey/hockey", () => {
  assert.equal(isSensitivePath("src/monkey.ts"), false);
  assert.equal(isSensitivePath("src/hockey.js"), false);
  assert.equal(isSensitivePath("src/keyboard.ts"), false);
  assert.equal(isSensitivePath("src/api_keys.ts"), false);
  assert.equal(isSensitivePath("src/credentials.ts"), false);
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

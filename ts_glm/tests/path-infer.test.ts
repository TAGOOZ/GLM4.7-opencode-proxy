import test from "node:test";
import assert from "node:assert/strict";
import { inferRecentFilePath } from "../src/proxy/tools/path.js";

test("inferRecentFilePath prefers recent .py paths", () => {
  const messages = [
    { role: "assistant", content: "Created simple calculator in calculator/ folder with calculator.py and README.md." },
    { role: "assistant", content: "Run with: python calculator/calculator.py" },
    { role: "user", content: "can u add sin cos etc ?" },
  ];
  assert.strictEqual(inferRecentFilePath(messages), "calculator/calculator.py");
});

test("inferRecentFilePath avoids .env when better candidates exist", () => {
  const messages = [
    { role: "assistant", content: "Config in .env" },
    { role: "assistant", content: "Edit calculator/calculator.py to add trig ops." },
  ];
  assert.strictEqual(inferRecentFilePath(messages), "calculator/calculator.py");
});


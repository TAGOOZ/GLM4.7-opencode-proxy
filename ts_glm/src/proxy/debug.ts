import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { PROXY_DEBUG } from "./constants.js";

const DEBUG_DUMP_DIR = process.env.PROXY_DEBUG_DUMP_DIR || "";

const nowIso = () => new Date().toISOString();

const safeJson = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return "\"[unserializable]\"";
  }
};

const truncate = (value: string, limit: number) => {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + `...[truncated ${value.length - limit} chars]`;
};

const debugLog = (...args: any[]) => {
  if (!PROXY_DEBUG) return;
  console.log("proxy_debug", nowIso(), ...args);
};

const debugDump = (label: string, payload: unknown, limit = 8000) => {
  if (!PROXY_DEBUG) return;
  const text = safeJson(payload);
  console.log("proxy_debug", nowIso(), label + ":", truncate(text, limit));
};

const writeDebugDump = async (prefix: string, payload: unknown) => {
  if (!PROXY_DEBUG || !DEBUG_DUMP_DIR) return;
  try {
    await fs.mkdir(DEBUG_DUMP_DIR, { recursive: true });
    const stamp = nowIso().replace(/[:.]/g, "-");
    const id = crypto.randomUUID().slice(0, 8);
    const filePath = path.join(DEBUG_DUMP_DIR, `${prefix}_${stamp}_${id}.json`);
    await fs.writeFile(filePath, safeJson(payload) + "\n", "utf-8");
    debugLog("debug_dump_written:", filePath);
  } catch (err) {
    debugLog("debug_dump_failed:", err instanceof Error ? err.message : String(err));
  }
};

export { debugDump, debugLog, truncate, safeJson, writeDebugDump };


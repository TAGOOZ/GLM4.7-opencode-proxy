import fs from "fs";
import path from "path";
import {
  getWorkspaceRoots,
  isSensitivePath,
  isUnsafePathInput,
  normalizePathForWorkspace,
} from "../../tools/pathSafety.js";

const WORKSPACE_ROOTS = getWorkspaceRoots();

const isSafeGlobPattern = (pattern: string): boolean => {
  const trimmed = pattern.trim();
  if (!trimmed) return true;
  const raw = trimmed.startsWith("!") ? trimmed.slice(1) : trimmed;
  if (!raw) return true;
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.startsWith("~")) return false;
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//")) return false;
  if (/(^|\/)\.\.(\/|$)/.test(normalized)) return false;
  if (/\{[^}]*\.\.[^}]*\}/.test(normalized)) return false;
  return true;
};

const getPathArgKey = (args: Record<string, unknown>): string | null => {
  if (args.path != null) return "path";
  if (args.filePath != null) return "filePath";
  if (args.file_path != null) return "file_path";
  if (args.dir != null) return "dir";
  return null;
};

const getWorkdirArgKey = (args: Record<string, unknown>): string | null => {
  if (args.workdir != null) return "workdir";
  if (args.cwd != null) return "cwd";
  if (args.directory != null) return "directory";
  return null;
};

const isExistingDirectory = (candidate: string): boolean => {
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

const resolveExistingDirectory = (candidate: string, workspaceRoots: string[]): string | null => {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string) => {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push(resolved);
  };
  if (path.isAbsolute(candidate)) {
    addCandidate(candidate);
  } else {
    for (const root of workspaceRoots) {
      addCandidate(path.resolve(root, candidate));
    }
    addCandidate(path.resolve(process.cwd(), candidate));
  }
  for (const resolved of candidates) {
    if (isExistingDirectory(resolved)) return resolved;
  }
  return null;
};

export {
  WORKSPACE_ROOTS,
  getPathArgKey,
  getWorkdirArgKey,
  isExistingDirectory,
  isSafeGlobPattern,
  isSensitivePath,
  isUnsafePathInput,
  normalizePathForWorkspace,
  resolveExistingDirectory,
};

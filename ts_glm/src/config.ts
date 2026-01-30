import fs from "fs";
import path from "path";
import os from "os";
import dotenv from "dotenv";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "glm-cli");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export const loadEnv = (): void => {
  dotenv.config();
  dotenv.config({ path: path.join(process.cwd(), ".env") });
  dotenv.config({ path: path.join(process.cwd(), "..", ".env") });
};

export const loadConfig = (): Record<string, unknown> => {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {
    return {};
  }
  return {};
};

export const saveConfig = (config: Record<string, unknown>): void => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
};

export const saveEnvToken = (token: string): void => {
  const candidatePaths = [path.join(process.cwd(), ".env"), path.join(process.cwd(), "..", ".env")];
  const envPath = fs.existsSync(candidatePaths[1]) ? candidatePaths[1] : candidatePaths[0];
  let lines: string[] = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  }
  let updated = false;
  const next = lines.map((line) => {
    if (line.startsWith("GLM_TOKEN=")) {
      updated = true;
      return `GLM_TOKEN=${token}`;
    }
    return line;
  });
  if (!updated) {
    next.push(`GLM_TOKEN=${token}`);
  }
  fs.writeFileSync(envPath, next.filter((l) => l.trim().length > 0).join("\n") + "\n");
};

export const loadToken = (): string | null => {
  loadEnv();
  if (process.env.GLM_TOKEN) {
    return process.env.GLM_TOKEN;
  }
  const cfg = loadConfig();
  const token = cfg.token;
  if (typeof token === "string" && token.length > 0) {
    return token;
  }
  return null;
};

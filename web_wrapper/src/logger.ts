import fs from "fs";
import type { ExecutionLogEntry } from "./types.js";

export class JsonlLogger {
  private path?: string;

  constructor(path?: string) {
    this.path = path;
  }

  log(entry: ExecutionLogEntry): void {
    if (!this.path) return;
    const line = JSON.stringify(entry);
    fs.appendFileSync(this.path, line + "\n");
  }
}

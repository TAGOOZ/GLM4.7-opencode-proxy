import type { Command } from "commander";
import { loadConfig, saveConfig, saveEnvToken } from "../../config.js";
import { GLMClient } from "../../glmClient.js";

export const registerConfigCommand = (program: Command) => {
  program
    .command("config")
    .requiredOption("--token <token>", "Authentication token")
    .action(async (opts) => {
      const cfg = loadConfig();
      cfg.token = opts.token;
      saveConfig(cfg);
      saveEnvToken(opts.token);
      console.log("✓ Token saved successfully!");
      try {
        const client = new GLMClient(opts.token);
        await client.getUserSettings();
        console.log("✓ Authenticated successfully!");
      } catch (err) {
        console.warn(`Warning: Could not verify token: ${(err as Error).message}`);
      }
    });
};

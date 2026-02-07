import type { Command } from "commander";
import { loadToken } from "../../config.js";
import { decodeJwtPayload } from "../../token.js";
import { getClient } from "../utils.js";

export const registerWhoamiCommand = (program: Command) => {
  program
    .command("whoami")
    .action(async () => {
      const client = getClient();
      try {
        const settings = await client.getUserSettings();
        if (settings && typeof settings === "object" && Object.keys(settings).length > 0) {
          console.log(JSON.stringify(settings, null, 2));
          return;
        }
        const token = loadToken();
        const payload = token ? decodeJwtPayload(token) : null;
        if (payload) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        console.log("null");
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
};

import type { Command } from "commander";
import { getClient } from "../utils.js";

export const registerNewCommand = (program: Command) => {
  program
    .command("new")
    .option("--title <title>", "Chat title", "New Chat")
    .option("--model <model>", "Model", "glm-4.7")
    .action(async (opts) => {
      const client = getClient();
      const chat = await client.createChat(opts.title, opts.model);
      console.log("✓ Chat created!");
      console.log(`ID: ${chat.id}`);
      console.log(`Title: ${chat.title}`);
      console.log(`Use: glm chat ${chat.id} \"Your message\"`);
    });
};

import type { Command } from "commander";
import { getClient } from "../utils.js";

export const registerChatsCommand = (program: Command) => {
  program
    .command("chats")
    .option("--page <page>", "Page number", "1")
    .action(async (opts) => {
      const client = getClient();
      const chats = await client.listChats(Number(opts.page));
      if (!chats.length) {
        console.log("No chats found.");
        return;
      }
      for (const chat of chats) {
        const shortId = chat.id.length > 11 ? `${chat.id.slice(0, 8)}...` : chat.id;
        const model = chat.models?.[0] || "unknown";
        console.log(`${shortId}\t${chat.title}\t${model}`);
      }
    });
};

import type { Command } from "commander";
import { getClient, writeStreamChunks } from "../utils.js";

export const registerChatCommand = (program: Command) => {
  program
    .command("chat")
    .argument("<chatId>")
    .argument("<message>")
    .option("--no-thinking", "Disable thinking")
    .action(async (chatId, message, opts) => {
      const client = getClient();
      process.stdout.write(`Sending to chat ${chatId.slice(0, 8)}...\n\n`);
      await writeStreamChunks(
        client.sendMessage({
          chatId,
          messages: [{ role: "user", content: message }],
          enableThinking: !opts.noThinking,
        }),
        { includeThinking: !opts.noThinking },
      );
    });
};

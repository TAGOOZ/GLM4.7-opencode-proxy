import type { Command } from "commander";
import { getClient } from "../utils.js";

export const registerChatCommand = (program: Command) => {
  program
    .command("chat")
    .argument("<chatId>")
    .argument("<message>")
    .option("--no-thinking", "Disable thinking")
    .action(async (chatId, message, opts) => {
      const client = getClient();
      process.stdout.write(`Sending to chat ${chatId.slice(0, 8)}...\n\n`);
      for await (const chunk of client.sendMessage({
        chatId,
        messages: [{ role: "user", content: message }],
        enableThinking: !opts.noThinking,
      })) {
        if (chunk.type === "thinking") {
          process.stdout.write(chunk.data);
        } else if (chunk.type === "content") {
          process.stdout.write(chunk.data);
        } else if (chunk.type === "error") {
          process.stderr.write(`\nError: ${chunk.data}\n`);
        }
      }
      process.stdout.write("\n");
    });
};

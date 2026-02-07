import type { Command } from "commander";
import { getClient } from "../utils.js";

export const registerInteractiveCommand = (program: Command) => {
  program
    .command("interactive")
    .option("--chat-id <id>", "Continue existing chat")
    .option("--model <model>", "Model", "glm-4.7")
    .action(async (opts) => {
      const client = getClient();
      let chatId = opts.chatId as string | undefined;
      if (!chatId) {
        const chat = await client.createChat("Interactive CLI Session", opts.model);
        chatId = chat.id;
        console.log(`✓ Created new chat: ${chatId}`);
      }

      console.log("GLM4.7 Interactive Mode. Type /quit to exit.");

      const handleInput = async (input: string) => {
        if (!input.trim()) return true;
        if (input.trim() === "/quit") return false;
        const messages = [{ role: "user", content: input }];
        for await (const chunk of client.sendMessage({
          chatId: chatId!,
          messages,
        })) {
          if (chunk.type === "content") {
            process.stdout.write(chunk.data);
          } else if (chunk.type === "error") {
            process.stderr.write(`\nError: ${chunk.data}\n`);
          }
        }
        process.stdout.write("\n");
        return true;
      };

      if (process.stdin.isTTY) {
        const rl = (await import("readline/promises")).createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true,
        });
        while (true) {
          let input = "";
          try {
            input = await rl.question("You: ");
          } catch (err) {
            if ((err as { code?: string }).code === "ERR_USE_AFTER_CLOSE") break;
            throw err;
          }
          const shouldContinue = await handleInput(input);
          if (!shouldContinue) break;
        }
        rl.close();
      } else {
        let buffer = "";
        for await (const chunk of process.stdin) {
          buffer += chunk.toString();
        }
        const lines = buffer.split(/\r?\n/);
        for (const line of lines) {
          if (!line && line !== "/quit") continue;
          const shouldContinue = await handleInput(line);
          if (!shouldContinue) break;
        }
      }
    });
};

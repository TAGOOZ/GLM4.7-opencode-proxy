#!/usr/bin/env node
import { Command } from "commander";
import { registerChatCommand } from "./cli/commands/chat.js";
import { registerChatsCommand } from "./cli/commands/chats.js";
import { registerConfigCommand } from "./cli/commands/config.js";
import { registerInteractiveCommand } from "./cli/commands/interactive.js";
import { registerLoginCommand } from "./cli/commands/login.js";
import { registerNewCommand } from "./cli/commands/new.js";
import { registerWhoamiCommand } from "./cli/commands/whoami.js";

const program = new Command();

program
  .name("glm")
  .description("GLM4.7 CLI")
  .version("0.1.0");

registerConfigCommand(program);
registerLoginCommand(program);
registerChatsCommand(program);
registerNewCommand(program);
registerChatCommand(program);
registerInteractiveCommand(program);
registerWhoamiCommand(program);

program.parse();

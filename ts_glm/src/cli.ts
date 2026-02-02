#!/usr/bin/env node
import { Command } from "commander";
import { loadToken, saveConfig, saveEnvToken, loadConfig } from "./config.js";
import { GLMClient } from "./glmClient.js";
import { decodeJwtPayload } from "./token.js";
import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";

const program = new Command();

const getClient = (): GLMClient => {
  const token = loadToken();
  if (!token) {
    console.error("No token configured. Set GLM_TOKEN or run 'glm config --token YOUR_TOKEN'.");
    process.exit(1);
  }
  return new GLMClient(token);
};

const expandHome = (input: string): string => {
  if (!input.startsWith("~")) return input;
  return path.join(os.homedir(), input.slice(1));
};

const defaultProfileDirs = new Set([
  path.join(os.homedir(), ".config", "google-chrome"),
  path.join(os.homedir(), ".config", "chromium"),
]);

const resolveProfileDir = (input?: string, channel?: string): string | null => {
  if (input) {
    const expanded = expandHome(input);
    if (defaultProfileDirs.has(expanded)) {
      return `${expanded}-glm`;
    }
    return expanded;
  }
  if (channel) {
    return path.join(os.homedir(), ".config", "glm-cli", `browser-profile-${channel}`);
  }
  return null;
};

const resolveChromeBinary = (explicit?: string, channel?: string): string | null => {
  const candidates: string[] = [];
  if (explicit) {
    candidates.push(explicit);
  }
  if (process.env.CHROME_BIN) {
    candidates.push(process.env.CHROME_BIN);
  }
  if (channel === "chrome") {
    candidates.push("google-chrome", "chrome", "chromium");
  } else if (channel === "chromium") {
    candidates.push("chromium", "chromium-browser", "google-chrome");
  } else {
    candidates.push("google-chrome", "chromium", "chromium-browser", "chrome");
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const which = spawnSync("which", [candidate], { stdio: "ignore" });
    if (which.status === 0) return candidate;
  }
  return null;
};

const waitForCdp = async (baseUrl: string, timeoutMs: number): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/json/version`);
      if (res.ok) return true;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

program
  .name("glm")
  .description("GLM4.7 CLI")
  .version("0.1.0");

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

program
  .command("login")
  .option("--headless", "Run browser headless", false)
  .option("--timeout <seconds>", "Seconds to wait for login", "300")
  .option("--check", "Validate saved token and exit", false)
  .option("--allow-guest", "Accept guest token without Google login", false)
  .option("--channel <channel>", "Playwright browser channel (chrome, chromium, msedge)")
  .option("--profile <path>", "Use a persistent browser profile directory")
  .option("--connect-cdp <url>", "Connect to an existing Chrome instance via CDP")
  .option("--remote-debugging-port <port>", "Connect to an existing Chrome on localhost CDP port")
  .option("--chrome-bin <path>", "Path to Chrome/Chromium binary for auto CDP")
  .option("--auto-cdp", "Launch Chrome with remote debugging and connect automatically", true)
  .action(async (opts) => {
    if (opts.check) {
      try {
        const client = getClient();
        await client.getUserSettings();
        console.log("✓ Token is valid.");
      } catch (err) {
        console.error(`Token invalid or expired: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }

    console.log("Login flow:\n1) A browser window will open at chat.z.ai\n2) Sign in with Google\n3) Return here and wait; token will be captured automatically");
    const timeoutMs = Number(opts.timeout) * 1000;
    const launchOptions: Record<string, unknown> = { headless: Boolean(opts.headless) };
    if (opts.channel) {
      launchOptions.channel = opts.channel;
    }
    const autoCdp = opts.autoCdp !== false;
    const cdpUrl = opts.connectCdp
      ? String(opts.connectCdp)
      : opts.remoteDebuggingPort
        ? `http://127.0.0.1:${String(opts.remoteDebuggingPort)}`
        : autoCdp
          ? "http://127.0.0.1:9222"
          : null;

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    let cdpBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
    let cdpProcess: ReturnType<typeof spawn> | null = null;
    let profileDir = resolveProfileDir(opts.profile, opts.channel);
    if (profileDir) {
      fs.mkdirSync(profileDir, { recursive: true });
      if (defaultProfileDirs.has(profileDir.replace(/-glm$/, ""))) {
        console.log(`Using dedicated profile: ${profileDir}`);
      }
    }

    let context = null as Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null;
    try {
      if (cdpUrl) {
        if (autoCdp && !opts.connectCdp && !opts.remoteDebuggingPort) {
          const chromeBinary = resolveChromeBinary(opts.chromeBin, opts.channel);
          if (!chromeBinary) {
            throw new Error(
              "No Chrome/Chromium binary found. Install Google Chrome/Chromium or pass --chrome-bin."
            );
          }
          const profileBase = profileDir || path.join(os.homedir(), ".config", "glm-cli", "chrome-debug");
          fs.mkdirSync(profileBase, { recursive: true });
          const port = 9222;
          cdpProcess = spawn(chromeBinary, [`--user-data-dir=${profileBase}`, `--remote-debugging-port=${port}`], {
            stdio: "ignore",
            detached: true,
          });
          let spawnError: Error | null = null;
          cdpProcess.on("error", (err) => {
            spawnError = err instanceof Error ? err : new Error(String(err));
          });
          const ready = await waitForCdp(cdpUrl, 10000);
          if (spawnError) {
            throw spawnError;
          }
          if (!ready) {
            throw new Error("Failed to connect to Chrome remote debugging port.");
          }
        }
        console.log(`Connecting to existing browser via CDP: ${cdpUrl}`);
        cdpBrowser = await chromium.connectOverCDP(cdpUrl);
        const contexts = cdpBrowser.contexts();
        context = (contexts.length ? contexts[0] : await cdpBrowser.newContext()) as typeof context;
      } else {
        context = profileDir
          ? await chromium.launchPersistentContext(profileDir, launchOptions)
          : ((browser = await chromium.launch(launchOptions)), await browser.newContext());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!cdpUrl && profileDir && /ProcessSingleton|non-default data directory/i.test(message)) {
        const fallback = path.join(os.homedir(), ".config", "glm-cli", `browser-profile-${Date.now()}`);
        fs.mkdirSync(fallback, { recursive: true });
        console.warn(`Profile locked or not allowed. Retrying with: ${fallback}`);
        context = await chromium.launchPersistentContext(fallback, launchOptions);
      } else {
        throw err;
      }
    }
    if (!context) {
      throw new Error("Failed to initialize browser context for login.");
    }
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://chat.z.ai", { waitUntil: "domcontentloaded" });

    const start = Date.now();
    let token: string | null = null;
    let initialToken: string | null = null;
    let warnedGuest = false;
    let lastCandidate: string | null = null;
    while (Date.now() - start < timeoutMs) {
      const cookies = await context.cookies();
      const tokenCookie = cookies.find((c) => c.name === "token");
      let candidate: string | null = null;
      if (tokenCookie?.value) {
        candidate = tokenCookie.value;
      }
      try {
        const local = await page.evaluate(() => localStorage.getItem("token") || localStorage.getItem("access_token") || "");
        if (local) {
          candidate = local;
        }
      } catch {
        // ignore
      }
      if (candidate) {
        lastCandidate = candidate;
        if (!initialToken) {
          initialToken = candidate;
        }
        if (opts.allowGuest) {
          token = candidate;
          break;
        }
        if (candidate !== initialToken) {
          token = candidate;
          break;
        }
        try {
          const client = new GLMClient(candidate);
          const settings = await client.getUserSettings();
          const email = typeof (settings as { email?: unknown }).email === "string" ? (settings as any).email : "";
          const isGuest = email.endsWith("@guest.com") || email.startsWith("Guest-");
          if (!isGuest) {
            token = candidate;
            break;
          }
          if (!warnedGuest) {
            console.log("Guest session detected. Complete Google sign-in, or re-run with --allow-guest.");
            warnedGuest = true;
          }
        } catch {
          // keep waiting for a usable token
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (browser) {
      await browser.close();
    } else if (cdpBrowser) {
      await cdpBrowser.close();
    } else if (context) {
      await context.close();
    }
    if (cdpProcess && typeof cdpProcess.pid === "number") {
      try {
        process.kill(-cdpProcess.pid);
      } catch {
        try {
          cdpProcess.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }

    if (!token) {
      if (lastCandidate) {
        console.warn("Could not verify token before timeout. Saving the latest token anyway.");
        token = lastCandidate;
      } else {
        console.error("Could not capture token. Try again or use 'glm config --token'.");
        process.exit(1);
      }
    }

    const cfg = loadConfig();
    cfg.token = token;
    saveConfig(cfg);
    saveEnvToken(token);
    console.log("✓ Token saved successfully!");
  });

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

program.parse();

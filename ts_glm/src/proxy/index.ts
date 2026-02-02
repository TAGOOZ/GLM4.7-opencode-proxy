#!/usr/bin/env node
import Fastify from "fastify";
import cors from "@fastify/cors";
import { GLMClient } from "../glmClient.js";
import { loadToken } from "../config.js";
import { DEFAULT_MODEL, PROXY_NEW_CHAT_PER_REQUEST } from "./constants.js";
import { createChatCompletionHandler } from "./handler.js";

const app = Fastify();
app.register(cors, { origin: true });

const token = loadToken();
if (!token) {
  console.error("Missing GLM token. Set GLM_TOKEN or run 'glm config --token'.");
  process.exit(1);
}

const client = new GLMClient(token);
let proxyChatId: string | null = null;

const ensureChat = async (): Promise<string> => {
  if (PROXY_NEW_CHAT_PER_REQUEST || !proxyChatId) {
    const chat = await client.createChat("OpenCode Proxy", DEFAULT_MODEL);
    proxyChatId = chat.id;
  }
  return proxyChatId;
};

const handleChatCompletion = createChatCompletionHandler({ client, ensureChat });

app.get("/", async () => ({ status: "ok", message: "GLM proxy is running" }));

app.get("/v1/models", async () => ({
  object: "list",
  data: [
    {
      id: DEFAULT_MODEL,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "z.ai",
    },
  ],
}));

app.get("/models", async () => ({
  object: "list",
  data: [
    {
      id: DEFAULT_MODEL,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "z.ai",
    },
  ],
}));

app.post("/v1/chat/completions", handleChatCompletion);
app.post("/chat/completions", handleChatCompletion);

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

app.listen({ port, host }).then(() => {
  console.log(`GLM proxy listening on http://${host}:${port}`);
});

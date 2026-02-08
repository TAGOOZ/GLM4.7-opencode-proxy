import { loadToken } from "../config.js";
import { GLMClient } from "../glmClient.js";
import type { StreamChunk } from "../glmClient/types.js";

export const getClient = (): GLMClient => {
  const token = loadToken();
  if (!token) {
    console.error("No token configured. Set GLM_TOKEN or run 'glm config --token YOUR_TOKEN'.");
    process.exit(1);
  }
  return new GLMClient(token);
};

export const writeStreamChunks = async (
  chunks: AsyncIterable<StreamChunk>,
  options?: { includeThinking?: boolean },
) => {
  const includeThinking = options?.includeThinking ?? false;
  for await (const chunk of chunks) {
    if (chunk.type === "content") {
      process.stdout.write(chunk.data);
    } else if (chunk.type === "thinking" && includeThinking) {
      process.stdout.write(chunk.data);
    } else if (chunk.type === "error") {
      process.stderr.write(`\nError: ${chunk.data}\n`);
    }
  }
  process.stdout.write("\n");
};

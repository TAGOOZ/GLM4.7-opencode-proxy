import { loadToken } from "../config.js";
import { GLMClient } from "../glmClient.js";

export const getClient = (): GLMClient => {
  const token = loadToken();
  if (!token) {
    console.error("No token configured. Set GLM_TOKEN or run 'glm config --token YOUR_TOKEN'.");
    process.exit(1);
  }
  return new GLMClient(token);
};

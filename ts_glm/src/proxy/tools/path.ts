const FILE_PATH_REGEX = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,10})/g;

const scorePath = (value: string): number => {
  const v = value.trim();
  if (!v) return -1;
  let score = 0;
  if (v.includes("/") || v.includes("\\")) score += 3;
  if (v.startsWith("./")) score += 1;
  if (v.endsWith(".py")) score += 5;
  if (v.endsWith(".ts")) score += 4;
  if (v.endsWith(".js")) score += 3;
  if (v.endsWith(".md")) score += 2;
  if (v.endsWith(".json")) score += 2;
  if (v.endsWith(".env")) score -= 10;
  if (v.includes("..")) score -= 10;
  return score;
};

const extractFilePaths = (text: string): string[] => {
  const found: string[] = [];
  if (!text) return found;
  const matches = text.matchAll(FILE_PATH_REGEX);
  for (const match of matches) {
    const raw = (match[1] || "").trim();
    if (!raw) continue;
    const cleaned = raw.replace(/[),.:;!?]+$/, "");
    found.push(cleaned);
  }
  return found;
};

// Best-effort: infer a "current working file" from recent conversation content.
// This is used to repair planner tool calls that forget to include a path/filePath.
const inferRecentFilePath = (messages: any[]): string | null => {
  const candidates: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const content =
      typeof msg?.content === "string"
        ? msg.content
        : Array.isArray(msg?.content)
          ? msg.content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("\n")
          : typeof msg?.content?.text === "string"
            ? msg.content.text
            : "";
    if (!content) continue;
    candidates.push(...extractFilePaths(content));
    if (candidates.length > 20) break;
  }
  if (!candidates.length) return null;
  const best = candidates
    .map((p) => ({ p, s: scorePath(p) }))
    .sort((a, b) => b.s - a.s)[0];
  return best && best.s > 0 ? best.p : null;
};

export { inferRecentFilePath };


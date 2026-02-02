export const DEFAULT_MODEL = "glm-4.7";

export const PROXY_DEBUG = process.env.PROXY_DEBUG === "1";
export const PROXY_NEW_CHAT_PER_REQUEST = process.env.PROXY_NEW_CHAT_PER_REQUEST === "1";
export const PROXY_ALLOW_WEB_SEARCH = process.env.PROXY_ALLOW_WEB_SEARCH === "1";
export const PROXY_TOOL_LOOP_LIMIT = Number(process.env.PROXY_TOOL_LOOP_LIMIT || "3");

export const ACTIONABLE_KEYWORDS = [
  "create",
  "write",
  "edit",
  "modify",
  "delete",
  "remove",
  "save",
  "rename",
  "move",
  "run",
  "execute",
  "install",
  "search",
  "find",
  "list",
  "open",
  "read",
  "inspect",
  "show",
  "contents",
  "grep",
  "rg",
  "ripgrep",
  "ls",
  "tree",
  "mkdir",
  "touch",
  "cp",
  "mv",
];

export const REPO_STRUCTURE_PATTERNS = [
  /(repo|repository|project|folder|directory).*(structure|tree|files|folders|contents|layout)/,
  /check (the )?(repo|repository|project)/,
];

export const EMBEDDED_READ_REGEX = /Called the Read tool with the following input/i;
export const FILE_MENTION_REGEX = /@[^\\s]+|[A-Za-z0-9_./-]+\\.[A-Za-z0-9]{1,10}/;
export const READ_LIKE_WITH_FILE_REGEX = /(summarize|summary|explain|describe|review|what does|what is in)/;
export const PLANNER_JSON_HINT_REGEX = /"actions"\s*:|"tool"\s*:|"plan"\s*:/;

export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bmkfs\b/i,
  /\bdd\b/i,
  /\bcurl\b.*\|\s*sh/i,
  /\bwget\b.*\|\s*sh/i,
  /:\(\)\s*\{:\|:&\};:/,
];

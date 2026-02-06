export const DEFAULT_MODEL = "glm-4.7";

export const PROXY_DEBUG = process.env.PROXY_DEBUG === "1";
export const PROXY_NEW_CHAT_PER_REQUEST = process.env.PROXY_NEW_CHAT_PER_REQUEST === "1";
export const PROXY_ALLOW_WEB_SEARCH = process.env.PROXY_ALLOW_WEB_SEARCH === "1";
export const PROXY_TOOL_LOOP_LIMIT = Number(process.env.PROXY_TOOL_LOOP_LIMIT || "3");
export const PROXY_INCLUDE_USAGE = process.env.PROXY_INCLUDE_USAGE !== "0";
export const PROXY_PLANNER_MAX_RETRIES = Number(process.env.PROXY_PLANNER_MAX_RETRIES || "1");
export const PROXY_MAX_ACTIONS_PER_TURN = Number(process.env.PROXY_MAX_ACTIONS_PER_TURN || "3");
export const PROXY_PLANNER_COERCE = process.env.PROXY_PLANNER_COERCE !== "0";
export const PROXY_USE_GLM_HISTORY = process.env.PROXY_USE_GLM_HISTORY === "1";
export const PROXY_HISTORY_MAX_MESSAGES = Number(process.env.PROXY_HISTORY_MAX_MESSAGES || "0");
export const PROXY_COMPACT_RESET = process.env.PROXY_COMPACT_RESET !== "0";
export const PROXY_ALWAYS_SEND_SYSTEM = process.env.PROXY_ALWAYS_SEND_SYSTEM !== "0";
export const PROXY_TEST_MODE = process.env.PROXY_TEST_MODE === "1";
export const PROXY_ALLOW_USER_HEURISTICS = process.env.PROXY_ALLOW_USER_HEURISTICS === "1";

// Prompt sizing controls. These significantly affect latency with OpenCode because tool schemas and
// client system prompts can be very large.
export const PROXY_TOOL_PROMPT_INCLUDE_SCHEMA = process.env.PROXY_TOOL_PROMPT_INCLUDE_SCHEMA === "1";
export const PROXY_TOOL_PROMPT_SCHEMA_MAX_CHARS = Number(process.env.PROXY_TOOL_PROMPT_SCHEMA_MAX_CHARS || "800");
export const PROXY_TOOL_PROMPT_EXTRA_SYSTEM_MAX_CHARS = Number(process.env.PROXY_TOOL_PROMPT_EXTRA_SYSTEM_MAX_CHARS || "800");

// Some GLM endpoints can be much slower with thinking enabled. Default is enabled unless you set this to 0.
export const PROXY_DEFAULT_THINKING = process.env.PROXY_DEFAULT_THINKING !== "0";

export const CONTEXT_MAX_TOKENS = Number(process.env.PROXY_CONTEXT_MAX_TOKENS || "200000");
export const CONTEXT_RESERVE_TOKENS = Number(process.env.PROXY_CONTEXT_RESERVE_TOKENS || "12000");
export const CONTEXT_SAFETY_MARGIN = Number(process.env.PROXY_CONTEXT_SAFETY_MARGIN || "15000");
export const CONTEXT_RECENT_MESSAGES = Number(process.env.PROXY_CONTEXT_RECENT_MESSAGES || "10");
export const CONTEXT_MIN_RECENT_MESSAGES = Number(process.env.PROXY_CONTEXT_MIN_RECENT_MESSAGES || "2");
export const CONTEXT_TOOL_MAX_LINES = Number(process.env.PROXY_CONTEXT_TOOL_MAX_LINES || "300");
export const CONTEXT_TOOL_MAX_CHARS = Number(process.env.PROXY_CONTEXT_TOOL_MAX_CHARS || "20000");
export const CONTEXT_SUMMARY_MAX_CHARS = Number(process.env.PROXY_CONTEXT_SUMMARY_MAX_CHARS || "1200");

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

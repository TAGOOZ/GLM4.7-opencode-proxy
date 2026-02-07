import { findTool, type ToolInfo } from "../../tools/registry.js";
import { pickArgKey } from "../../tools/inferUtils.js";

export type GuardResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      confirmationToolCalls?: any[];
      pendingConfirmation?: { id: string; toolCalls: any[]; blockedReason: string };
    };

const CONFIRM_TOOL_NAMES = [
  "question",
  "askquestion",
  "ask_question",
  "confirm",
  "confirm_action",
  "request_confirmation",
];

const buildConfirmationToolCall = (
  registry: Map<string, ToolInfo>,
  question: string,
): any[] | null => {
  const buildQuestionsArgs = () => ({
    questions: [
      {
        header: "Confirm",
        id: `confirm_${Math.random().toString(36).slice(2, 10)}`,
        question,
        options: [
          {
            label: "Proceed (Recommended)",
            description: "Approve the action and continue.",
          },
          {
            label: "Cancel",
            description: "Decline the action and stop.",
          },
        ],
      },
    ],
  });
  for (const name of CONFIRM_TOOL_NAMES) {
    const toolInfo = findTool(registry, name);
    if (!toolInfo) continue;
    const argKeys = new Set((toolInfo.argKeys || []).map((k) => k.toLowerCase()));
    const key = pickArgKey(toolInfo, ["question", "prompt", "text", "message", "input", "questions"]);
    const toolName = toolInfo.tool.function?.name || toolInfo.tool.name || name;
    const args =
      key === "questions" || argKeys.has("questions")
        ? buildQuestionsArgs()
        : { [key]: question };
    return [
      {
        id: `call_confirm_${Math.random().toString(36).slice(2, 8)}`,
        index: 0,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
      },
    ];
  }
  return null;
};

const NON_CONFIRMABLE_GUARD_REASONS = new Set([
  "invalid_tool_args",
  "unexpected_arg",
  "missing_path",
  "missing_command",
  "missing_content",
  "invalid_content_type",
]);

const confirmOrBlock = (
  registry: Map<string, ToolInfo>,
  blockedReason: string,
  question: string,
  toolCallsToReplay: any[],
): GuardResult => {
  if (NON_CONFIRMABLE_GUARD_REASONS.has(blockedReason)) {
    return { ok: false, reason: blockedReason };
  }
  const confirmationToolCalls = buildConfirmationToolCall(registry, question);
  if (confirmationToolCalls && confirmationToolCalls.length > 0) {
    const id = String(confirmationToolCalls[0]?.id || "");
    return {
      ok: false,
      reason: "confirmation_required",
      confirmationToolCalls,
      pendingConfirmation: {
        id,
        toolCalls: toolCallsToReplay,
        blockedReason,
      },
    };
  }
  return { ok: false, reason: blockedReason };
};

export { confirmOrBlock };

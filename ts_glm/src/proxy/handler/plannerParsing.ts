import { PROXY_DEBUG, PROXY_PLANNER_MAX_RETRIES } from "../constants.js";
import { estimateMessagesTokens } from "../context.js";
import { tryParseModelOutput, tryRepairPlannerOutput } from "../tools/parse.js";

type ParsedOutput = ReturnType<typeof tryParseModelOutput>;

type ParsePlannerOutputParams = {
  activeChatId: string;
  glmMessages: { role: string; content: string }[];
  initialResponseText: string;
  responsePromptTokens: number;
  collectModelResponse: (
    chatId: string,
    requestMessages: { role: string; content: string }[],
    options?: { parentMessageId?: string | null },
  ) => Promise<string>;
  plannerParentMessageId?: string | null;
};

export const parsePlannerOutput = async (
  params: ParsePlannerOutputParams,
): Promise<{
  responseText: string;
  initialResponseText: string;
  parsed: ParsedOutput;
  responsePromptTokens: number;
}> => {
  const {
    activeChatId,
    glmMessages,
    initialResponseText,
    responsePromptTokens: initialPromptTokens,
    collectModelResponse,
    plannerParentMessageId,
  } = params;
  let responseText = initialResponseText;
  let responsePromptTokens = initialPromptTokens;

  let parsed = tryParseModelOutput(responseText, false);
  if (!parsed.ok) {
    const repaired = tryRepairPlannerOutput(responseText);
    if (repaired) {
      parsed = { ok: true, data: repaired };
    }
  }
  if (PROXY_DEBUG && !parsed.ok) {
    console.log("proxy_debug json_parse_error:", parsed.error);
  }
  if (!parsed.ok && PROXY_PLANNER_MAX_RETRIES > 0) {
    // one retry with corrective message
    const corrective = {
      role: "assistant",
      content: "Return ONLY valid JSON following the schema. No extra text or analysis.",
    };
    const correctedMessages = [...glmMessages, corrective];
    responseText = await collectModelResponse(activeChatId, correctedMessages, {
      parentMessageId: plannerParentMessageId,
    });
    responsePromptTokens = estimateMessagesTokens(correctedMessages);
    if (PROXY_DEBUG) {
      const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}...` : responseText;
      console.log("proxy_debug model_retry_raw:", preview);
    }
    parsed = tryParseModelOutput(responseText, false);
    if (!parsed.ok) {
      const repaired = tryRepairPlannerOutput(responseText);
      if (repaired) {
        parsed = { ok: true, data: repaired };
      }
    }
    if (PROXY_DEBUG && !parsed.ok) {
      console.log("proxy_debug json_parse_error:", parsed.error);
    }
  }

  if (!parsed.ok && PROXY_PLANNER_MAX_RETRIES > 1) {
    const stricter = {
      role: "assistant",
      content: "Return ONLY valid JSON object. No markdown, no analysis, no extra keys.",
    };
    const stricterMessages = [...glmMessages, stricter];
    responseText = await collectModelResponse(activeChatId, stricterMessages, {
      parentMessageId: plannerParentMessageId,
    });
    responsePromptTokens = estimateMessagesTokens(stricterMessages);
    if (PROXY_DEBUG) {
      const preview = responseText.length > 400 ? `${responseText.slice(0, 400)}...` : responseText;
      console.log("proxy_debug model_retry2_raw:", preview);
    }
    parsed = tryParseModelOutput(responseText, false);
    if (!parsed.ok) {
      const repaired = tryRepairPlannerOutput(responseText);
      if (repaired) {
        parsed = { ok: true, data: repaired };
      }
    }
    if (PROXY_DEBUG && !parsed.ok) {
      console.log("proxy_debug json_parse_error:", parsed.error);
    }
  }

  if (!parsed.ok) {
    parsed = tryParseModelOutput(responseText, true);
    if (!parsed.ok && responseText !== initialResponseText) {
      parsed = tryParseModelOutput(initialResponseText, true);
    }
  }

  if (!parsed.ok || !parsed.data) {
    const repaired = tryRepairPlannerOutput(responseText);
    if (repaired) {
      parsed = { ok: true, data: repaired };
    }
  }

  return {
    responseText,
    initialResponseText,
    parsed,
    responsePromptTokens,
  };
};

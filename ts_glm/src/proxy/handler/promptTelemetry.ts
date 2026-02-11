type PromptMessage = { role: string; content: string };

type PromptRecord = {
  collect_call_index: number;
  prompt_chars: number;
  system_chars: number;
  history_chars: number;
  prompt_chars_delta_prev: number;
  prompt_chars_delta_first: number;
};

type PromptSummary = {
  collect_calls: number;
  prompt_chars_min: number;
  prompt_chars_max: number;
  prompt_chars_avg: number;
  prompt_chars_first: number;
  prompt_chars_last: number;
};

const collectPromptCharStats = (messages: PromptMessage[]) => {
  let promptChars = 0;
  let systemChars = 0;
  let historyChars = 0;
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : String(msg.content ?? "");
    const chars = content.length;
    promptChars += chars;
    if (msg.role === "system") {
      systemChars += chars;
    } else {
      historyChars += chars;
    }
  }
  return { promptChars, systemChars, historyChars };
};

const createPromptTelemetryTracker = () => {
  let collectCalls = 0;
  let firstPromptChars: number | null = null;
  let previousPromptChars: number | null = null;
  let promptCharsMin = Number.POSITIVE_INFINITY;
  let promptCharsMax = Number.NEGATIVE_INFINITY;
  let promptCharsSum = 0;

  const record = (messages: PromptMessage[]): PromptRecord => {
    const stats = collectPromptCharStats(messages);
    collectCalls += 1;
    if (firstPromptChars === null) {
      firstPromptChars = stats.promptChars;
    }
    const promptDeltaFromPrev =
      previousPromptChars === null ? 0 : stats.promptChars - previousPromptChars;
    const promptDeltaFromFirst = stats.promptChars - (firstPromptChars ?? stats.promptChars);
    previousPromptChars = stats.promptChars;
    promptCharsMin = Math.min(promptCharsMin, stats.promptChars);
    promptCharsMax = Math.max(promptCharsMax, stats.promptChars);
    promptCharsSum += stats.promptChars;

    return {
      collect_call_index: collectCalls,
      prompt_chars: stats.promptChars,
      system_chars: stats.systemChars,
      history_chars: stats.historyChars,
      prompt_chars_delta_prev: promptDeltaFromPrev,
      prompt_chars_delta_first: promptDeltaFromFirst,
    };
  };

  const summary = (): PromptSummary | null => {
    if (collectCalls === 0 || firstPromptChars === null || previousPromptChars === null) {
      return null;
    }
    return {
      collect_calls: collectCalls,
      prompt_chars_min: promptCharsMin,
      prompt_chars_max: promptCharsMax,
      prompt_chars_avg: Number((promptCharsSum / collectCalls).toFixed(2)),
      prompt_chars_first: firstPromptChars,
      prompt_chars_last: previousPromptChars,
    };
  };

  return { record, summary };
};

export { createPromptTelemetryTracker, type PromptRecord, type PromptSummary };

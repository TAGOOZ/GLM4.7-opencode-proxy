const stripThoughtProcess = (text: string, thinking: string) => {
  const stripLeadingNoise = (input: string) => {
    let output = input;
    while (true) {
      const next = output.replace(/^\s*(true">|<\/?details[^>]*>|<\/?think[^>]*>)\s*/i, "");
      if (next === output) break;
      output = next;
    }
    return output;
  };

  const stripQuotedBlock = (input: string) => {
    const cleaned = stripLeadingNoise(input);
    const lines = cleaned.split(/\r?\n/);
    let idx = 0;
    while (idx < lines.length && lines[idx].trim() === "") idx += 1;
    if (idx < lines.length && /^(thinking|thought process)\s*:?\s*$/i.test(lines[idx].trim())) {
      idx += 1;
    }
    const startIdx = idx;
    let consumed = 0;
    while (idx < lines.length) {
      const line = lines[idx];
      if (line.trim() === "") {
        consumed += 1;
        idx += 1;
        if (consumed > 0) break;
        continue;
      }
      if (line.trim().startsWith(">")) {
        idx += 1;
        consumed += 1;
        continue;
      }
      break;
    }
    if (idx > startIdx) {
      return lines.slice(idx).join("\n");
    }
    return cleaned;
  };

  const heading = text.match(/(^|\n)\s*(Thought Process|Thinking)\s*:?\s*\n/i);
  if (heading) {
    const start = heading.index ?? 0;
    const after = start + heading[0].length;
    const rest = text.slice(after);
    const sepMatch = rest.match(/\n\s*\n/);
    if (!sepMatch) {
      return { text: "", pending: true };
    }
    const end = after + rest.indexOf(sepMatch[0]) + sepMatch[0].length;
    const stripped = text.slice(0, start) + text.slice(end);
    return { text: stripQuotedBlock(stripped), pending: false };
  }

  const trimmedThinking = thinking.trim();
  if (trimmedThinking) {
    const trimmedText = text.trimStart();
    const leadingIndex = text.length - trimmedText.length;
    const prefixMatch = trimmedText.match(/^(Thinking|Thought Process)\s*:?\s*>?\s*/i);
    const compareStart = prefixMatch ? trimmedText.slice(prefixMatch[0].length) : trimmedText;
    if (compareStart.length < trimmedThinking.length && trimmedThinking.startsWith(compareStart)) {
      return { text: "", pending: true };
    }
    if (compareStart.startsWith(trimmedThinking)) {
      const start = prefixMatch ? leadingIndex : text.indexOf(trimmedThinking);
      if (start !== -1) {
        const removeLength = prefixMatch ? prefixMatch[0].length + trimmedThinking.length : trimmedThinking.length;
        const stripped = text.slice(0, start) + text.slice(start + removeLength);
        return { text: stripQuotedBlock(stripped), pending: false };
      }
    }
  }

  return { text: stripQuotedBlock(text), pending: false };
};

export { stripThoughtProcess };

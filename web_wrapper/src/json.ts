export const removeComments = (input: string): string => {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1] || "";

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        out += ch;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    out += ch;
  }

  return out;
};

export const removeTrailingCommas = (input: string): string => {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j += 1;
      if (j < input.length && (input[j] === "}" || input[j] === "]")) {
        continue;
      }
    }

    out += ch;
  }

  return out;
};

export const repairPlannerJson = (input: string): string => {
  let repaired = removeTrailingCommas(removeComments(input));
  const planMatch = repaired.match(/"plan"\s*:\s*([\s\S]*?)(?=,\s*"actions"\s*:)/);
  if (planMatch && !planMatch[1].trim().startsWith("[")) {
    const body = planMatch[1].trim().replace(/,\s*$/, "");
    repaired = repaired.replace(planMatch[0], `"plan": [${body}]`);
  }
  const actionsMatch = repaired.match(/"actions"\s*:\s*([\s\S]*?)(?=,\s*"(final|thought)"\s*:|}$)/);
  if (actionsMatch && !actionsMatch[1].trim().startsWith("[")) {
    const body = actionsMatch[1].trim().replace(/,\s*$/, "");
    repaired = repaired.replace(actionsMatch[0], `"actions": [${body}]`);
  }
  return repaired;
};

export const removeComments = (input: string): string => {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
};

export const removeTrailingCommas = (input: string): string => {
  return input.replace(/,\s*([}\]])/g, "$1");
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

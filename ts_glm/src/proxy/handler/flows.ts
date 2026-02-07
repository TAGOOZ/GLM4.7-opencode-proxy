import { createFallbackFlows } from "./fallbackFlow.js";
import { createPlannerFlow } from "./plannerFlow.js";
import type { PlannerFlowDeps } from "./flowTypes.js";

export type { PlannerFlowContext, StreamFallbackContext, NonStreamFallbackContext } from "./flowTypes.js";

export const createHandlerFlows = (deps: PlannerFlowDeps) => {
  const { handlePlannerFlow } = createPlannerFlow(deps);
  const { handleStreamNoTools, handleNonStreamNoTools } = createFallbackFlows(deps);
  return { handlePlannerFlow, handleStreamNoTools, handleNonStreamNoTools };
};

import type {
  ConditionDiagnostics,
  ConditionPhase,
} from "@/contracts/condition-expression";
export function conditionDecisionFor(
  diagnostics: ConditionDiagnostics | undefined,
  nodeId: string,
  phase: ConditionPhase,
  key: string,
  activationId: string | undefined,
) {
  if (!diagnostics || !activationId) return undefined;
  const decision = diagnostics.latest[nodeId + "/" + phase + "/" + key];
  return decision?.activationId === activationId ? decision : undefined;
}

/** 预览设备行为时，按契约逐条比较参数、现场观测和授权值。缺少对应值的条件标记为未知。 */

import type { Condition, ParamValue } from "@/contracts/device";
export function evaluateConditions(
  conditions: Condition[],
  parameters: Record<string, ParamValue>,
  observations: Record<string, ParamValue>,
  authorization: Record<string, ParamValue>,
) {
  return conditions.map((condition) => {
    const source =
      condition.source === "parameter"
        ? parameters
        : condition.source === "authorization"
          ? authorization
          : observations;
    return {
      ...condition,
      state: !(condition.key in source)
        ? ("unknown" as const)
        : source[condition.key] === condition.equals
          ? ("satisfied" as const)
          : ("unsatisfied" as const),
    };
  });
}

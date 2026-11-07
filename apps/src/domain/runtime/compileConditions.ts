import { z } from "zod";
import {
  conditionModelSchema,
  type CompiledCondition,
  type ConditionExpr,
  type ConditionModel,
  type ConditionPhase,
} from "@/contracts/condition-expression";

/** Validates data before any runtime provider is selected; descriptions are never executable. */
export function compileConditions(
  device: string,
  raw: Record<string, unknown>,
  behaviorId: string,
): CompiledCondition[] {
  const contract = z
    .object({
      runtime_contract: z.object({
        condition_model: z.unknown(),
        observation_definitions: z.record(
          z.string(),
          z.object({ expression_ref: z.string().optional() }).passthrough(),
        ),
        authorization_definitions: z.record(
          z.string(),
          z.object({ expression_ref: z.string().optional() }).passthrough(),
        ),
      }),
      signal_ports: z.array(
        z.object({
          port_id: z.string(),
          value_type: z.string(),
          unit: z.string().optional(),
        }),
      ),
      params_schema: z.record(
        z.string(),
        z
          .object({ type: z.string(), unit: z.string().optional() })
          .passthrough(),
      ),
      runtime_execution_contract: z
        .object({
          payload_templates: z
            .record(
              z.string(),
              z.object({ fields: z.record(z.string(), z.unknown()) }),
            )
            .optional(),
        })
        .passthrough(),
      transport_behaviors: z.array(
        z.object({
          behavior_id: z.string(),
          arguments_schema: z.record(z.string(), z.unknown()),
          condition_contract: z.object({
            preconditions: z.array(
              z.object({
                key: z.string(),
                source: z.string(),
                equals: z.boolean(),
              }),
            ),
            sustaining_conditions: z.array(
              z.object({
                key: z.string(),
                source: z.string(),
                equals: z.boolean(),
              }),
            ),
          }),
          completion_contract: z.object({
            checks: z.array(
              z.object({
                key: z.string(),
                source: z.string(),
                equals: z.boolean(),
              }),
            ),
          }),
        }),
      ),
    })
    .parse(raw);
  let budget = 0;
  function guard(v: unknown, depth = 0) {
    if (++budget > 40000 || depth > 80)
      throw new Error("Condition declaration complexity exceeded");
    if (v && typeof v === "object")
      Object.values(v).forEach((x) => guard(x, depth + 1));
  }
  guard(contract.runtime_contract.condition_model);
  const model = conditionModelSchema.parse(
      contract.runtime_contract.condition_model,
    ),
    behavior = contract.transport_behaviors.find(
      (b) => b.behavior_id === behaviorId,
    );
  if (!behavior) throw new Error("Unknown condition behavior");
  const declarations = [
    ...behavior.condition_contract.preconditions.map((c) => ({
      c,
      phase: (c.source === "authorization"
        ? "authorization"
        : "precondition") as ConditionPhase,
    })),
    ...behavior.condition_contract.sustaining_conditions.map((c) => ({
      c,
      phase: "sustaining" as const,
    })),
    ...behavior.completion_contract.checks.map((c) => ({
      c,
      phase: "completion" as const,
    })),
  ];
  return declarations.map(({ c, phase }) => {
    const registered =
      c.source === "authorization"
        ? contract.runtime_contract.authorization_definitions
        : contract.runtime_contract.observation_definitions;
    const entry = model.expressions[c.key];
    if (!entry || registered[c.key]?.expression_ref !== c.key)
      throw new Error("Unregistered condition expression: " + c.key);
    if ((entry.status === "opaque") !== (entry.expr.op === "opaque"))
      throw new Error("Condition status differs");
    const used: ConditionModel["bindings"] = {};
    function infer(e: ConditionExpr, depth = 0): [string, string] {
      if (depth > 32) throw new Error("Condition expression depth exceeded");
      const child = (n: ConditionExpr) => infer(n, depth + 1);
      if (e.op === "opaque") {
        if (e !== entry.expr || e.key !== c.key || e.source !== c.source)
          throw new Error("Invalid opaque delegation");
        return ["boolean", "1"];
      }
      if (e.op === "literal") {
        const type = typeof e.value;
        if (type !== "number" && e.unit !== "1")
          throw new Error("Non-numeric unit");
        return [type, e.unit];
      }
      if (e.op === "ref") {
        const b = model.bindings[e.binding];
        if (!b || b.behavior !== behaviorId)
          throw new Error("Missing or foreign condition binding: " + e.binding);
        used[e.binding] = b;
        if (
          !e.binding.startsWith(behaviorId + ".") ||
          (!["number", "integer"].includes(b.value_type) && b.unit !== "1")
        )
          throw new Error("Invalid binding identity/unit");
        if (b.kind === "signal" || b.kind === "parameter") {
          const d =
            b.kind === "signal"
              ? contract.signal_ports.find((p) => p.port_id === b.port)
              : contract.params_schema[b.parameter];
          const type =
            d &&
            ("value_type" in d
              ? d.value_type
              : d.type === "enum"
                ? "string"
                : d.type);
          if (!d || type !== b.value_type || (d.unit ?? "1") !== b.unit)
            throw new Error("Signal/parameter type or unit mismatch");
          if (
            b.kind === "signal" &&
            ((phase === "completion" &&
              ["done", "accepted", "result_id"].includes(b.port)) ||
              (phase === "precondition" &&
                ["execute", "start_pick", "release_waiting_material"].includes(
                  b.port,
                )))
          )
            throw new Error("Circular condition feedback");
        }
        if (
          (b.kind === "authorization" && phase === "precondition") ||
          (b.kind === "request" && phase === "precondition")
        )
          throw new Error("Admission depends on its own submission");
        if (
          b.kind === "request" &&
          (!b.scope.startsWith("request") || b.value_type !== "boolean")
        )
          throw new Error("Invalid request identity binding");
        if (
          "scope" in b &&
          b.scope.endsWith("subject") &&
          !(
            "subject_id" in behavior!.arguments_schema ||
            "material" in behavior!.arguments_schema ||
            "material" in
              (contract.runtime_execution_contract.payload_templates?.[
                behaviorId
              ]?.fields ?? {})
          )
        )
          throw new Error("Subject correlation without subject");
        if (
          b.kind === "profile" &&
          (b.value_type !== "number" ||
            b.unit !== (b.parameter === "position_tolerance_m" ? "m" : "m/s"))
        )
          throw new Error("Profile type/unit mismatch");
        if (b.kind === "observation" || b.kind === "authorization")
          for (const ref of Object.values(b.arguments)) {
            if (ref.from === "self") continue;
            const keys =
              ref.from === "argument"
                ? behavior!.arguments_schema
                : (contract.runtime_execution_contract.payload_templates?.[
                    behaviorId
                  ]?.fields ?? {});
            if (!(ref.name in keys))
              throw new Error("Unknown condition context field");
          }
        return [b.value_type, b.unit];
      }
      if (e.op === "not") {
        const a = child(e.arg);
        if (a[0] !== "boolean") throw new Error("NOT requires Boolean");
        return a;
      }
      if (e.op === "all" || e.op === "any") {
        if (e.args.some((x) => child(x)[0] !== "boolean"))
          throw new Error("Logical operand requires Boolean");
        return ["boolean", "1"];
      }
      if (e.op !== "compare")
        throw new Error("Unsupported condition expression");
      const a = child(e.left),
        b = child(e.right),
        numeric = [a[0], b[0]].every((t) => ["number", "integer"].includes(t));
      if (
        a[1] !== b[1] ||
        (!numeric && a[0] !== b[0]) ||
        (!numeric && !["eq", "ne"].includes(e.operator))
      )
        throw new Error("Comparison type/unit mismatch");
      return ["boolean", "1"];
    }
    if (infer(entry.expr)[0] !== "boolean")
      throw new Error("Condition must return Boolean");
    return {
      key: device + "/" + c.key,
      device,
      behavior: behaviorId,
      expected: c.equals,
      phase,
      expr: entry.expr,
      bindings: used,
    };
  });
}

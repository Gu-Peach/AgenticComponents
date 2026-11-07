import { z } from "zod";
import type { SignalQuality } from "./scene-signals";
export type Scalar = boolean | number | string;
export type ConditionExpr =
  | { op: "all" | "any"; args: ConditionExpr[] }
  | { op: "not"; arg: ConditionExpr }
  | {
      op: "compare";
      operator: "eq" | "ne" | "lt" | "le" | "gt" | "ge";
      left: ConditionExpr;
      right: ConditionExpr;
    }
  | { op: "ref"; binding: string }
  | { op: "literal"; value: Scalar; unit: string }
  | { op: "opaque"; source: "observation" | "authorization"; key: string };
export const conditionExprSchema: z.ZodType<ConditionExpr> = z.lazy(() =>
  z.union([
    z
      .object({
        op: z.enum(["all", "any"]),
        args: z.array(conditionExprSchema).min(1).max(128),
      })
      .strict(),
    z.object({ op: z.literal("not"), arg: conditionExprSchema }).strict(),
    z
      .object({
        op: z.literal("compare"),
        operator: z.enum(["eq", "ne", "lt", "le", "gt", "ge"]),
        left: conditionExprSchema,
        right: conditionExprSchema,
      })
      .strict(),
    z.object({ op: z.literal("ref"), binding: z.string().min(1) }).strict(),
    z
      .object({
        op: z.literal("literal"),
        value: z.union([z.boolean(), z.number().finite(), z.string()]),
        unit: z.string().min(1),
      })
      .strict(),
    z
      .object({
        op: z.literal("opaque"),
        source: z.enum(["observation", "authorization"]),
        key: z.string(),
      })
      .strict(),
  ]),
);
const common = {
  behavior: z.string(),
  value_type: z.enum(["boolean", "integer", "number", "string"]),
  unit: z.string().min(1),
};
const scope = z.enum(["run", "run_subject", "request", "request_subject"]);
const selector = z.union([
  z.object({ from: z.literal("self") }).strict(),
  z
    .object({ from: z.enum(["argument", "payload"]), name: z.string() })
    .strict(),
]);
export const conditionBindingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("signal"),
      device: z.literal("self"),
      port: z.string(),
      scope,
      required_quality: z.literal("good"),
      freshness: z.literal("signal_definition"),
    })
    .strict(),
  z
    .object({ ...common, kind: z.literal("parameter"), parameter: z.string() })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("profile"),
      profile: z.literal("scene.assembly@1"),
      parameter: z.enum(["position_tolerance_m", "speed_tolerance_mps"]),
      implementation_status: z.literal("pending_profile_binding"),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("observation"),
      provider: z.string(),
      description: z.string(),
      scope,
      arguments: z.record(z.string(), selector),
      sample_keys: z.array(z.string()).min(1),
      max_age_ticks: z.number().int().positive(),
      implementation_status: z.literal("pending_provider_binding"),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("authorization"),
      provider: z.string(),
      scope,
      arguments: z.record(z.string(), selector),
      resource_set: z.literal("compiled_action_footprint"),
      implementation_status: z.literal("pending_provider_binding"),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("request"),
      field: z.enum(["matching_accepted", "matching_success"]),
      scope,
      implementation_status: z.literal("pending_request_trace_binding"),
    })
    .strict(),
]);
export const conditionModelSchema = z
  .object({
    schema_version: z.literal("ac-condition/0.1"),
    execution_mode: z.literal("declaration_only"),
    unknown_policy: z.literal("three_valued_fail_closed"),
    bindings: z.record(z.string(), conditionBindingSchema),
    expressions: z.record(
      z.string(),
      z
        .object({
          status: z.enum(["structured", "opaque"]),
          expr: conditionExprSchema,
          note: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type ConditionBinding = z.infer<typeof conditionBindingSchema>;
export type ConditionModel = z.infer<typeof conditionModelSchema>;
export type ConditionPhase =
  | "precondition"
  | "authorization"
  | "sustaining"
  | "completion"
  | "release"
  | "stopped"
  | "finalization"
  | "gate";
export interface BindingReading {
  value: Scalar | null;
  quality: SignalQuality;
  sampledTick: number;
  source: string;
  reason?: string;
}
export interface ConditionNodeTrace extends BindingReading {
  path: string;
  op: ConditionExpr["op"];
  binding?: string;
  unit: string;
}
export interface ConditionDecision {
  runId: string;
  nodeId: string;
  activationId: string;
  requestId?: string;
  subjectId?: string;
  conditionKey: string;
  phase: ConditionPhase;
  evaluatedTick: number;
  inputSampleTick: number;
  value: boolean | null;
  quality: SignalQuality;
  nodes: readonly ConditionNodeTrace[];
  legacyValue?: boolean | null;
}
export interface ConditionDiagnostics {
  mode: "expression" | "compare" | "legacy";
  latest: Readonly<Record<string, ConditionDecision>>;
  lastSequence: number;
  dropped: number;
  events: readonly (ConditionDecision & { sequence: number })[];
  comparisons: number;
  mismatches: number;
}
export interface CompiledCondition {
  key: string;
  device: string;
  behavior: string;
  expected: boolean;
  phase: ConditionPhase;
  expr: ConditionExpr;
  bindings: Readonly<Record<string, ConditionBinding>>;
}

import { z } from "zod";
import type { ActionBinding } from "@/contracts/scheduler";
import type { SceneSignalDefinition } from "@/contracts/scene-signals";
const condition = z.object({
  key: z.string(),
  source: z.enum(["parameter", "observation", "authorization"]),
});
const argument = z.object({
  type: z.enum(["number", "integer", "string", "boolean", "enum"]),
  required: z.boolean().optional(),
  unit: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
const specSchema = z.object({
  schema_type: z.literal("DeviceSpec"),
  version: z.string(),
  signal_ports: z.array(
    z.object({
      port_id: z.string(),
      direction: z.enum(["input", "output"]),
      plc_type: z.enum(["BOOL", "INT", "DINT", "REAL"]),
      unit: z.string().optional(),
      retention: z.string().optional(),
    }),
  ),
  transport_behaviors: z.array(
    z.object({
      behavior_id: z.string(),
      schedulable: z.boolean(),
      behavior_type: z.string(),
      arguments_schema: z.record(z.string(), argument),
      input_signals: z.array(z.string()),
      output_signals: z.array(z.string()),
      condition_contract: z.object({
        preconditions: z.array(condition),
        sustaining_conditions: z.array(condition),
      }),
      completion_contract: z.object({
        mode: z.enum(["continuous", "observed"]),
        checks: z.array(condition),
      }),
    }),
  ),
});
export function signalLayoutFromContract(
  sceneId: string,
  device: string,
  raw: unknown,
  feedbackMaxAgeTicks = 2,
): SceneSignalDefinition[] {
  const spec = specSchema.parse(raw);
  return spec.signal_ports.map((p) => ({
    key: `${sceneId}/${device}/${p.port_id}`,
    direction: p.direction,
    type: p.plc_type,
    unit: p.unit,
    writer: p.direction === "input" ? "process" : `adapter:${device}`,
    maxAgeTicks:
      p.direction === "output" && p.retention === "sampled_state"
        ? feedbackMaxAgeTicks
        : undefined,
  }));
}
export function bindDeviceBehavior(
  device: string,
  raw: unknown,
  behaviorId: string,
  implementation: {
    contractVersion: string;
    resources: ActionBinding["resources"];
    stopped: readonly string[];
    release?: readonly string[];
    parameters?: Record<string, unknown>;
    validatePayload: (payload: unknown) => void;
  },
): ActionBinding {
  const spec = specSchema.parse(raw),
    b = spec.transport_behaviors.find((b) => b.behavior_id === behaviorId);
  if (
    !b ||
    !b.schedulable ||
    ["internal", "observer", "passive"].includes(b.behavior_type)
  )
    throw new Error("Behavior is not callable");
  if (implementation.contractVersion !== spec.version)
    throw new Error("Adapter contract version mismatch");
  if (!implementation.stopped.length || !b.completion_contract.checks.length)
    throw new Error("Missing physical completion/stop evidence");
  const configuration = z
    .object({
      params_schema: z
        .record(z.string(), z.object({ default: z.unknown().optional() }))
        .optional(),
      transport_behaviors: z.array(
        z.object({
          behavior_id: z.string(),
          applicability: z
            .object({
              conditions: z.array(
                z.object({ parameter: z.string(), equals: z.unknown() }),
              ),
            })
            .optional(),
        }),
      ),
      runtime_execution_contract: z
        .object({
          argument_variants: z
            .record(
              z.string(),
              z.object({
                selector_parameter: z.string(),
                variants: z.record(
                  z.string(),
                  z.object({
                    required: z.array(z.string()),
                    forbidden: z.array(z.string()),
                  }),
                ),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    .parse(raw);
  const parameters = {
    ...Object.fromEntries(
      Object.entries(configuration.params_schema ?? {}).map(([k, v]) => [
        k,
        v.default,
      ]),
    ),
    ...implementation.parameters,
  };
  const gates =
    configuration.transport_behaviors.find((b) => b.behavior_id === behaviorId)
      ?.applicability?.conditions ?? [];
  for (const gate of gates)
    if (
      !Object.hasOwn(parameters, gate.parameter) ||
      parameters[gate.parameter] !== gate.equals
    )
      throw new Error("Behavior not applicable to configured device");
  const variants =
    configuration.runtime_execution_contract?.argument_variants?.[behaviorId];
  const ports = new Map(spec.signal_ports.map((p) => [p.port_id, p]));
  for (const key of b.input_signals)
    if (ports.get(key)?.direction !== "input")
      throw new Error("Invalid input binding");
  for (const key of b.output_signals)
    if (ports.get(key)?.direction !== "output")
      throw new Error("Invalid output binding");
  const qualify = (c: { key: string }) => `${device}/${c.key}`;
  return {
    device,
    behavior: behaviorId,
    continuous: b.completion_contract.mode === "continuous",
    preconditions: b.condition_contract.preconditions
      .filter((c) => c.source !== "authorization")
      .map(qualify),
    authorization: b.condition_contract.preconditions
      .filter((c) => c.source === "authorization")
      .map(qualify),
    sustaining: b.condition_contract.sustaining_conditions.map(qualify),
    completion: b.completion_contract.checks.map(qualify),
    release: implementation.release ?? [],
    stopped: implementation.stopped,
    resources: implementation.resources,
    validateArguments(args, payload) {
      if (variants) {
        const variant =
          variants.variants[String(parameters[variants.selector_parameter])];
        if (
          !variant ||
          variant.required.some((k) => !Object.hasOwn(args, k)) ||
          variant.forbidden.some((k) => Object.hasOwn(args, k))
        )
          throw new Error("Arguments conflict with configured mode");
      }
      for (const key of Object.keys(args))
        if (!Object.hasOwn(b.arguments_schema, key))
          throw new Error("Unknown behavior argument: " + key);
      for (const [key, p] of Object.entries(b.arguments_schema)) {
        let value = args[key];
        if (value === undefined) {
          if (p.required) throw new Error("Missing argument: " + key);
          continue;
        }
        if (p.unit && p.unit !== "1") {
          const q = value as { value: unknown; unit: string };
          if (!q || q.unit !== p.unit)
            throw new Error("Argument unit mismatch");
          value = q.value;
        }
        if (p.type === "number" || p.type === "integer") {
          if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            (p.type === "integer" && !Number.isInteger(value)) ||
            value < (p.min ?? -Infinity) ||
            value > (p.max ?? Infinity)
          )
            throw new Error("Numeric argument outside contract");
        } else if (p.type === "enum") {
          if (!p.options?.includes(value as string))
            throw new Error("Invalid enum");
        } else if (typeof value !== p.type)
          throw new Error("Argument type mismatch");
      }
      implementation.validatePayload(payload);
    },
  };
}

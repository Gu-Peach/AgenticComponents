/** 按类型查找编译时登记的设备工厂。旧载具使用物料模块，动作状态由每次实例化独立持有。 */
import { z } from "zod";
import catalog from "./catalog.json";
import dispatch from "./.generated/dispatch-signatures.json";
import robot_arm from "./robot_arm";
import conveyor from "./conveyor";
import rotary_table from "./rotary_table";
import machine_tool from "./machine_tool";
import material_source_station from "./material_source_station";
import workpiece from "./workpiece";
import linear_rail from "./linear_rail";
import lift_table from "./lift_table";
import storage_rack from "./storage_rack";
import human_operator from "./human_operator";

const modules = {
  robot_arm,
  conveyor,
  rotary_table,
  machine_tool,
  material_source_station,
  workpiece,
  linear_rail,
  lift_table,
  storage_rack,
  human_operator,
} as const;
export type DeviceModuleType = keyof typeof modules;

export function canonicalDeviceType(type: string): DeviceModuleType {
  const aliases: Readonly<Record<string, string>> = catalog.legacy_types;
  const key = Object.hasOwn(aliases, type) ? aliases[type] : type;
  if (!Object.hasOwn(modules, key) || !Object.hasOwn(catalog.devices, key))
    throw new Error("设备库未注册类型 " + type);
  return key as DeviceModuleType;
}
export function getDeviceModule<K extends DeviceModuleType>(
  type: K,
): (typeof modules)[K];
export function getDeviceModule(
  type: "workpiece_carrier",
): typeof modules.workpiece;
export function getDeviceModule(
  type: string,
): (typeof modules)[DeviceModuleType];
export function getDeviceModule(type: string) {
  return modules[canonicalDeviceType(type)];
}

const condition = z.object({
  source: z.string(),
  key: z.string(),
  equals: z.union([z.boolean(), z.number(), z.string()]),
});
const schema = z.object({
  schema_type: z.literal("DeviceSpec"),
  schema_id: z.string(),
  device_type: z.string(),
  device_spec_id: z.string(),
  version: z.string(),
  contract_version: z.string(),
  signal_ports: z.array(
    z.object({
      port_id: z.string(),
      direction: z.enum(["input", "output"]),
      plc_type: z.string(),
      value_type: z.string(),
      unit: z.string().optional(),
      signal_role: z.string(),
      retention: z.string(),
    }),
  ),
  transport_behaviors: z.array(
    z.object({
      behavior_id: z.string(),
      behavior_type: z.string(),
      executor_ref: z.string(),
      schedulable: z.boolean(),
      arguments_schema: z.record(
        z.string(),
        z.object({
          type: z.string(),
          required: z.boolean().optional(),
          unit: z.string().optional(),
          min: z.number().optional(),
          max: z.number().optional(),
          options: z
            .array(z.union([z.string(), z.number(), z.boolean()]))
            .optional(),
        }),
      ),
      input_signals: z.array(z.string()),
      output_signals: z.array(z.string()),
      condition_contract: z.object({
        missing_value_policy: z.literal("unknown_blocks_execution"),
        preconditions: z.array(condition),
        sustaining_conditions: z.array(condition),
      }),
      completion_contract: z.object({
        mode: z.enum(["continuous", "observed"]),
        timer_or_progress_is_success: z.literal(false),
        checks: z.array(condition),
      }),
    }),
  ),
  runtime_contract: z.object({
    condition_model: z
      .object({
        expressions: z.record(
          z.string(),
          z.object({
            status: z.string(),
            expr: z.record(z.string(), z.unknown()),
          }),
        ),
        bindings: z.record(z.string(), z.record(z.string(), z.unknown())),
      })
      .optional(),
  }),
  runtime_execution_contract: z.object({
    payload_templates: z
      .record(
        z.string(),
        z.object({
          fields: z.record(z.string(), z.string()),
          optional_fields: z.record(z.string(), z.string()).optional(),
        }),
      )
      .optional(),
  }),
});
type Spec = z.infer<typeof schema>;
type Declaration = Spec["transport_behaviors"][number];
type SignatureIndex = {
  behaviors: Record<string, number>;
  signals: string[][];
};
const signatureIndex: Readonly<Record<string, SignatureIndex>> =
  dispatch.profiles;
const signatures = dispatch.signatures.map((signature) =>
  JSON.stringify(signature),
);
// A previously published declaration without the optional extension accepts the same required wire format.
const requiredOnlySignatures = dispatch.signatures.map((signature) => {
  const last: unknown = signature.at(-1);
  return last && typeof last === "object" && "optional_fields" in last
    ? JSON.stringify(signature.slice(0, -1))
    : undefined;
});
const published = Object.entries(catalog.profiles).map(([name, p]) => ({
  name,
  type: p.type,
  id: p.spec_id,
  version: p.version,
  format: p.contract_version,
}));
const templates = Object.entries(modules).map(([type, deviceModule]) => ({
  name: "template/" + type,
  type,
  id: deviceModule.contract.device_spec_id,
  version: deviceModule.contract.version,
  format: deviceModule.contract.contract_version,
}));
const versions = [...published, ...templates];
function orderedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.keys(record)
    .sort()
    .map((key) => [key, record[key]]);
}
function orderedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      orderedEntries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        orderedJson(v),
      ]),
    );
  return value;
}

function signalLayout(spec: Spec) {
  const signals = Object.fromEntries(
    spec.signal_ports.map((port) => [port.port_id, port]),
  );
  if (Object.keys(signals).length !== spec.signal_ports.length)
    throw new Error("设备信号端口重复");
  return orderedEntries(signals).map(([id, p]) => [
    id,
    p.direction,
    p.plc_type,
    p.value_type,
    p.unit ?? "1",
    p.retention,
    p.signal_role,
  ]);
}
function signatureOf(
  spec: Spec,
  action: Declaration,
  signals: Map<string, Spec["signal_ports"][number]>,
) {
  const id = action.behavior_id;
  const layout = (direction: "input" | "output") =>
    [...(direction === "input" ? action.input_signals : action.output_signals)]
      .sort()
      .map((name) => {
        const p = signals.get(name);
        if (p?.direction !== direction)
          throw new Error("设备信号方向或引用错误：" + id + "." + name);
        return [name, p.plc_type, p.unit ?? "1"];
      });
  const model = spec.runtime_contract.condition_model;
  const predicates = (checks: z.infer<typeof condition>[]) =>
    checks.map((c) => {
      const entry = model?.expressions[c.key];
      const prefix: unknown[] = [
        c.source,
        c.key,
        c.equals,
        entry?.status ?? null,
      ];
      if (!model || entry?.status !== "structured") return prefix;
      const refs = new Set<string>();
      function collect(node: unknown) {
        if (!node || typeof node !== "object") return;
        if (
          "op" in node &&
          node.op === "ref" &&
          "binding" in node &&
          typeof node.binding === "string"
        )
          refs.add(node.binding);
        for (const child of Object.values(node)) collect(child);
      }
      collect(entry.expr);
      const sources: Record<string, unknown> = {};
      for (const name of refs) {
        const binding = model.bindings[name];
        if (!binding)
          throw new Error("Unknown executor condition binding: " + name);
        sources[name] = Object.fromEntries(
          Object.entries(binding).filter(
            ([k]) =>
              k !== "description" &&
              k !== "note" &&
              k !== "implementation_status",
          ),
        );
      }
      return [...prefix, orderedJson([entry.expr, sources])];
    });
  const optional = orderedEntries(
    spec.runtime_execution_contract.payload_templates?.[id]?.optional_fields ??
      {},
  );
  return JSON.stringify([
    action.behavior_type,
    action.schedulable,
    action.executor_ref,
    action.completion_contract.mode,
    orderedEntries(action.arguments_schema).map(([name, arg]) => [
      name,
      arg.type,
      arg.required ?? false,
      arg.unit ?? "1",
      arg.min ?? null,
      arg.max ?? null,
      arg.options ?? null,
    ]),
    orderedEntries(
      spec.runtime_execution_contract.payload_templates?.[id]?.fields ?? {},
    ),
    layout("input"),
    layout("output"),
    predicates(action.condition_contract.preconditions),
    predicates(action.condition_contract.sustaining_conditions),
    predicates(action.completion_contract.checks),
    ...(optional.length ? [{ optional_fields: optional }] : []),
  ]);
}

/** 在准备阶段核对实际行为签名、输入/反馈布局及型号修订。几何、节点和实例参数可单独配置。 */
export function resolveDeviceAction(
  raw: Record<string, unknown>,
  behavior: string,
) {
  const spec = schema.parse(raw),
    type = canonicalDeviceType(spec.device_type),
    deviceModule = modules[type];
  const actions = new Map(
    spec.transport_behaviors.map((b) => [b.behavior_id, b]),
  );
  if (
    spec.schema_id !== spec.device_spec_id ||
    actions.size !== spec.transport_behaviors.length ||
    !actions.get(behavior)?.schedulable ||
    !deviceModule.contract.transport_behaviors.some(
      (b) => b.behavior_id === behavior,
    )
  )
    throw new Error(
      "Unsupported executor: " + spec.device_spec_id + "." + behavior,
    );

  const known = versions.filter((p) => p.id === spec.device_spec_id);
  const candidates = known.length
    ? known.filter(
        (p) => p.version === spec.version && p.format === spec.contract_version,
      )
    : versions.filter((p) => p.format === spec.contract_version);
  const ports = new Map(spec.signal_ports.map((p) => [p.port_id, p]));
  const layout = signalLayout(spec);
  const actual = Array.from(
    actions,
    ([id, b]) => [id, signatureOf(spec, b, ports)] as const,
  );
  const matches = candidates.some((p) => {
    if (p.type !== type) return false;
    const profile = signatureIndex[p.name];
    if (!profile) return false;
    if (known.length) {
      if (
        Object.keys(profile.behaviors).length !== actual.length ||
        JSON.stringify(profile.signals) !== JSON.stringify(layout)
      )
        return false;
    } else {
      // A new model may select a subset, preserving each selected port's ABI.
      const allowed = new Map(
        profile.signals.map((signal) => [signal[0], JSON.stringify(signal)]),
      );
      if (
        layout.some(
          (signal) => allowed.get(signal[0]) !== JSON.stringify(signal),
        )
      )
        return false;
    }
    return actual.every(
      ([id, signature]) =>
        signatures[profile.behaviors[id]] === signature ||
        requiredOnlySignatures[profile.behaviors[id]] === signature,
    );
  });
  if (!matches)
    throw new Error(
      "Unsupported executor profile or signature: " +
        spec.device_spec_id +
        "@" +
        spec.version +
        "." +
        behavior,
    );
  return deviceModule;
}

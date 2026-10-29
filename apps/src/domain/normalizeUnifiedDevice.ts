import {
  conveyorModelSchema,
  signalManagementSchema,
} from "@/contracts/conveyor";
import { z } from "zod";
import { deviceTypes } from "@/contracts/device";
import { spatialInterfaceSchema } from "@/contracts/spatial";
import {
  condition,
  parameterSchema,
  definitionSchema,
  semanticIssues,
} from "@/validation/contracts";
const parameter = parameterSchema.extend({
  required: z.boolean(),
  mutability: z.enum(["stopped_only", "runtime_setpoint"]),
  description: z.string().min(1),
});
const schema = z
  .object({
    contract_version: z.literal("1.1"),
    schema_type: z.literal("DeviceSpec"),
    schema_id: z.string().min(1),
    device_spec_id: z.string().min(1),
    device_type: z.enum(deviceTypes),
    version: z.string().min(1),
    display_name: z.string().min(1),
    description: z.string(),
    asset: z
      .object({
        model_format: z.literal("glb"),
        model_key: z.string().min(1),
        root_node_name: z.string().optional(),
      })
      .passthrough(),
    params_schema: z.record(z.string(), parameter),
    type_specific_contract: z.record(z.string(), z.unknown()),
    interfaces: z.array(spatialInterfaceSchema),
    signal_ports: z.array(
      z
        .object({
          port_id: z.string().min(1),
          direction: z.enum(["input", "output"]),
          value_type: z.enum(["boolean", "integer", "number"]),
          plc_type: z.enum(["BOOL", "INT", "DINT", "REAL"]),
          description: z.string(),
          signal_role: z.string().min(1),
          retention: z.string().min(1),
        })
        .passthrough(),
    ),
    transport_behaviors: z.array(
      z
        .object({
          behavior_id: z.string().min(1),
          display_name: z.string().min(1),
          behavior_type: z.enum([
            "action",
            "composite",
            "service",
            "passive",
            "observer",
            "internal",
          ]),
          schedulable: z.boolean(),
          executor_ref: z.string().min(1),
          implementation_status: z.enum(["pending_adapter", "implemented"]),
          arguments_schema: z.record(z.string(), parameterSchema),
          trigger: z.record(z.string(), z.unknown()),
          input_signals: z.array(z.string()),
          output_signals: z.array(z.string()),
          condition_contract: z
            .object({
              preconditions: z.array(condition),
              sustaining_conditions: z.array(condition),
              missing_value_policy: z.literal("unknown_blocks_execution"),
            })
            .strict(),
          completion_contract: z
            .object({
              mode: z.enum(["observed", "continuous"]),
              description: z.string().min(1),
              checks: z.array(condition),
              timer_or_progress_is_success: z.literal(false),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
    runtime_contract: z
      .object({
        observation_definitions: z.record(z.string(), z.unknown()),
        authorization_definitions: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
    runtime_execution_contract: z.record(z.string(), z.unknown()),
  })
  .passthrough();
export function normalizeUnifiedDevice(raw: unknown) {
  const s = schema.parse(raw);
  if (s.schema_id !== s.device_spec_id)
    throw new Error("schema_id 与 device_spec_id 不一致");
  for (const key of [
    "physical_interfaces",
    "process_ports",
    "interface_bindings",
  ])
    if (key in s) throw new Error(`统一接口格式禁止重复声明 ${key}`);
  signalManagementSchema.parse(s.runtime_execution_contract.signal_management);
  for (const p of s.signal_ports)
    if ("bound_to" in p) throw new Error("设备信号禁止绑定空间接口");
  if (s.device_type === "conveyor") {
    const model = conveyorModelSchema.parse(s.type_specific_contract);
    const surface = model.conveying_surface;
    for (const region of model.observation_regions) {
      if (region.surface_ref !== surface.surface_id)
        throw new Error("观测区域的输送面引用不存在");
      for (const key of region.observation_keys)
        if (!Object.hasOwn(s.runtime_contract.observation_definitions, key))
          throw new Error("观测区域引用未登记的观测");
    }
    if (
      new Set(model.observation_regions.map((r) => r.region_id)).size !==
      model.observation_regions.length
    )
      throw new Error("观测区域 ID 重复");
    if (
      !Array.isArray(s.type_specific_contract.node_bindings) ||
      !s.type_specific_contract.node_bindings.some(
        (b: { role?: string }) => b.role === surface.node_binding_role,
      )
    )
      throw new Error("输送面节点角色不存在");
    for (const [key, id] of Object.entries(surface.drive)) {
      if (!key.endsWith("_signal")) continue;
      const port = s.signal_ports.find((p) => p.port_id === id);
      if (
        !port ||
        port.direction !==
          (key === "actual_speed_signal" ? "output" : "input") ||
        port.plc_type !== (key === "run_signal" ? "BOOL" : "REAL")
      )
        throw new Error("输送面驱动信号引用、方向或类型错误");
    }
  }
  const ids = new Map(s.signal_ports.map((p) => [p.port_id, p]));
  for (const p of s.signal_ports) {
    const expected =
      p.plc_type === "BOOL"
        ? "boolean"
        : p.plc_type === "REAL"
          ? "number"
          : "integer";
    if (p.value_type !== expected)
      throw new Error(`${p.port_id}: PLC 类型与值类型不一致`);
  }
  for (const b of s.transport_behaviors) {
    for (const id of b.input_signals)
      if (ids.get(id)?.direction !== "input")
        throw new Error(`${b.behavior_id}: 输入信号引用或方向错误 ${id}`);
    for (const id of b.output_signals)
      if (ids.get(id)?.direction !== "output")
        throw new Error(`${b.behavior_id}: 输出信号引用或方向错误 ${id}`);
    for (const c of [
      ...b.condition_contract.preconditions,
      ...b.condition_contract.sustaining_conditions,
      ...b.completion_contract.checks,
    ]) {
      const source =
        c.source === "parameter"
          ? s.params_schema
          : c.source === "observation"
            ? s.runtime_contract.observation_definitions
            : s.runtime_contract.authorization_definitions;
      if (!Object.hasOwn(source, c.key))
        throw new Error(`${b.behavior_id}: 条件来源未声明 ${c.key}`);
    }
  }
  const def = definitionSchema.parse({
    specId: s.device_spec_id,
    revision: s.version,
    name: s.display_name,
    deviceType: s.device_type,
    description: s.description,
    template: false,
    asset: { sourceKey: s.asset.model_key, rootNode: s.asset.root_node_name },
    paramsSchema: s.params_schema,
    typeSpecificContract: s.type_specific_contract,
    spatialInterfaces: s.interfaces,
    interfaces: s.signal_ports.map((p) => ({
      id: p.port_id,
      direction: p.direction,
      valueType: p.plc_type,
      description: p.description,
    })),
    behaviors: s.transport_behaviors.map((b) => ({
      id: b.behavior_id,
      label: b.display_name,
      kind: b.behavior_type,
      schedulable: b.schedulable,
      implementationStatus: b.implementation_status,
      executorRef: b.executor_ref,
      arguments: b.arguments_schema,
      requiredInterfaces: [
        ...new Set([...b.input_signals, ...b.output_signals]),
      ],
      preconditions: b.condition_contract.preconditions,
      sustainingConditions: b.condition_contract.sustaining_conditions,
      completion: b.completion_contract.description,
      completionChecks: b.completion_contract.checks,
      completionMode: b.completion_contract.mode,
    })),
    source: structuredClone(raw),
    diagnostics: [
      "设备契约 1.1 已加载；空间吸附、接口求解与真实执行器仍需接入。",
    ],
  });
  const errors = semanticIssues(def);
  if (errors.length) throw new Error(errors.join("；"));
  return def;
}

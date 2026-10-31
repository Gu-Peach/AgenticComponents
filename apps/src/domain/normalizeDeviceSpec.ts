import { normalizeUnifiedDevice } from "./normalizeUnifiedDevice";
import { z } from "zod";
import {
  definitionSchema,
  parameterSchema,
  semanticIssues,
} from "@/validation/contracts";
import {
  deviceTypes,
  type DeviceDefinition,
  type BehaviorContract,
} from "@/contracts/device";
const legacy = z
  .object({
    schema_type: z.literal("DeviceSpec"),
    device_spec_id: z.string(),
    device_type: z.enum(deviceTypes),
    version: z.string(),
    display_name: z.string(),
    description: z.string().optional(),
    asset: z.object({
      model_key: z.string().optional(),
      root_node_name: z.string().optional(),
    }),
    params_schema: z.record(z.string(), parameterSchema),
    type_specific_contract: z.record(z.string(), z.unknown()),
    signal_ports: z.array(
      z.object({
        port_id: z.string(),
        direction: z.enum(["input", "output", "inout"]),
        value_type: z.string(),
        description: z.string().optional(),
      }),
    ),
    transport_behaviors: z.array(
      z.object({
        behavior_id: z.string(),
        default_algorithm: z.string().optional(),
        input_signals: z.array(z.string()).optional(),
        output_signals: z.array(z.string()).optional(),
        control_signals: z.array(z.string()).optional(),
        preconditions: z.array(z.string()).optional(),
        effects: z.array(z.string()).optional(),
      }),
    ),
  })
  .passthrough();
export function normalizeDeviceSpec(raw: unknown): DeviceDefinition {
  if (raw && typeof raw === "object" && "specId" in raw) {
    const def = definitionSchema.parse(raw);
    const errors = semanticIssues(
      def,
      {},
      ["1.3", "1.4"].includes(String(def.source?.contract_version)),
    );
    if (errors.length) throw new Error(errors.join("；"));
    return def;
  }
  if (raw && typeof raw === "object" && "contract_version" in raw)
    return normalizeUnifiedDevice(raw);
  const s = legacy.parse(raw);
  const passive =
    s.device_type === "workpiece" || s.device_type === "workpiece_carrier";
  const behaviors: BehaviorContract[] = s.transport_behaviors.map((b) => ({
    id: b.behavior_id,
    label: b.behavior_id,
    kind: passive ? "passive" : "action",
    executorRef: `agent.${b.default_algorithm ?? b.behavior_id}`,
    arguments: {},
    requiredInterfaces: [
      ...new Set([
        ...(b.input_signals ?? []),
        ...(b.output_signals ?? []),
        ...(b.control_signals ?? []),
      ]),
    ],
    preconditions: (b.preconditions ?? []).map((label, i) => ({
      id: `legacy-${i}`,
      label,
      source: "observation",
      key: `legacy:${label}`,
      equals: true,
    })),
    completion: b.effects?.join("；") || "需迁移执行器并补充完成观测契约",
    completionChecks: [],
  }));
  const def: DeviceDefinition = {
    specId: s.device_spec_id,
    revision: s.version,
    name: s.display_name,
    deviceType: s.device_type,
    description: s.description ?? "",
    template: false,
    asset: { sourceKey: s.asset.model_key, rootNode: s.asset.root_node_name },
    paramsSchema: s.params_schema,
    typeSpecificContract: s.type_specific_contract,
    interfaces: s.signal_ports.map((p) => ({
      id: p.port_id,
      direction: p.direction,
      valueType: p.value_type,
      description: p.description ?? "",
    })),
    behaviors,
    source: structuredClone(raw) as Record<string, unknown>,
    diagnostics: [
      "旧 DeviceSpec 已规范化；原始字段保留在 source。",
      "旧字符串前置条件作为未知观测保留，不自动求值。",
      "真实动作执行器及完成观测需要接入；坐标/TCP 需按模型校准。",
    ],
  };
  const errors = semanticIssues(
    def,
    {},
    ["1.3", "1.4"].includes(String(def.source?.contract_version)),
  );
  if (errors.length) throw new Error(errors.join("；"));
  return def;
}

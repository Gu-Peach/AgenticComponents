import { spatialInterfaceSchema } from "@/contracts/spatial";
import { z } from "zod";
import {
  deviceTypes,
  type DeviceDefinition,
  type ParameterSpec,
  type ParamValue,
} from "@/contracts/device";
const value = z.union([z.string(), z.number().finite(), z.boolean()]);
export const parameterSchema = z.object({
  type: z.enum(["number", "integer", "boolean", "string", "enum"]),
  default: value.optional(),
  required: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().optional(),
  description: z.string().optional(),
  options: z.array(value).optional(),
  required_when: z.object({ parameter: z.string(), equals: value }).optional(),
  mutability: z.enum(["stopped_only", "runtime_setpoint"]).optional(),
});
export const condition = z.object({
  id: z.string(),
  label: z.string(),
  source: z.enum(["parameter", "observation", "authorization"]),
  key: z.string(),
  equals: value,
});
export const definitionSchema = z.object({
  specId: z.string().min(1),
  revision: z.string(),
  name: z.string().min(1),
  deviceType: z.enum(deviceTypes),
  description: z.string(),
  template: z.boolean(),
  asset: z.object({
    assetId: z.string().optional(),
    sourceKey: z.string().optional(),
    rootNode: z.string().optional(),
    sourceUrl: z.string().optional(),
    sha256: z.string().optional(),
    importTransform: z
      .object({
        position: z.tuple([
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
        ]),
        rotation: z.tuple([
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
        ]),
        scale: z
          .tuple([
            z.number().finite(),
            z.number().finite(),
            z.number().finite(),
          ])
          .refine((v) => v.every((n) => n > 0)),
      })
      .optional(),
  }),
  paramsSchema: z.record(z.string(), parameterSchema),
  typeSpecificContract: z.record(z.string(), z.unknown()),
  spatialInterfaces: z.array(spatialInterfaceSchema).optional(),
  interfaces: z.array(
    z.object({
      id: z.string(),
      direction: z.enum(["input", "output", "inout"]),
      valueType: z.string(),
      description: z.string(),
    }),
  ),
  behaviors: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum([
        "action",
        "composite",
        "service",
        "passive",
        "observer",
        "internal",
      ]),
      schedulable: z.boolean().optional(),
      implementationStatus: z
        .enum(["pending_adapter", "implemented"])
        .optional(),
      sustainingConditions: z.array(condition).optional(),
      completionMode: z.enum(["continuous", "observed"]).optional(),
      executorRef: z.string(),
      arguments: z.record(z.string(), parameterSchema),
      requiredInterfaces: z.array(z.string()),
      preconditions: z.array(condition),
      completion: z.string(),
      completionChecks: z.array(condition),
    }),
  ),
  source: z.record(z.string(), z.unknown()).optional(),
  diagnostics: z.array(z.string()),
});
const vec = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
export const projectSchema = z.object({
  format: z.literal("agentic-workbench"),
  version: z.literal(1),
  id: z.string(),
  name: z.string().min(1),
  revision: z.number().int().nonnegative(),
  definitions: z.array(definitionSchema),
  instances: z.array(
    z.object({
      instanceId: z.string(),
      specId: z.string(),
      specRevision: z.string(),
      name: z.string(),
      visible: z.boolean(),
      transform: z.object({
        position: vec,
        rotation: vec,
        scale: vec.refine((v) => v.every((n) => n > 0), "缩放必须大于零"),
      }),
      paramOverrides: z.record(z.string(), value),
      bindings: z.record(z.string(), z.string()),
    }),
  ),
  assets: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.literal("glb"),
      size: z.number().nonnegative(),
    }),
  ),
  connections: z
    .array(
      z.object({
        id: z.string().min(1),
        a: z.object({ instanceId: z.string(), interfaceId: z.string() }),
        b: z.object({ instanceId: z.string(), interfaceId: z.string() }),
      }),
    )
    .optional(),
  plc: z.string(),
});
export function resolveParameters(
  def: DeviceDefinition,
  overrides: Record<string, ParamValue>,
) {
  const result: Record<string, ParamValue> = {};
  for (const [key, spec] of Object.entries(def.paramsSchema))
    if (spec.default !== undefined) result[key] = spec.default;
  return { ...result, ...overrides };
}
export function validateParameters(
  schema: Record<string, ParameterSpec>,
  values: Record<string, ParamValue>,
) {
  const errors: string[] = [];
  for (const [key, spec] of Object.entries(schema)) {
    const v = values[key];
    const required =
      spec.required ||
      (spec.required_when &&
        values[spec.required_when.parameter] === spec.required_when.equals);
    if (v === undefined) {
      if (required) errors.push(`${key}: 必填参数缺失`);
      continue;
    }
    if (
      (spec.type === "number" || spec.type === "integer") &&
      (typeof v !== "number" ||
        !Number.isFinite(v) ||
        (spec.type === "integer" && !Number.isInteger(v)))
    )
      errors.push(
        `${key}: 需要有效的${spec.type === "integer" ? "整数" : "数值"}`,
      );
    if (spec.type === "boolean" && typeof v !== "boolean")
      errors.push(`${key}: 需要布尔值`);
    if (spec.type === "string" && typeof v !== "string")
      errors.push(`${key}: 需要字符串`);
    if (spec.type === "enum" && !spec.options?.includes(v))
      errors.push(`${key}: 不在可选值中`);
    if (
      typeof v === "number" &&
      ((spec.min !== undefined && v < spec.min) ||
        (spec.max !== undefined && v > spec.max))
    )
      errors.push(`${key}: 超出范围 ${spec.min ?? "−∞"} … ${spec.max ?? "∞"}`);
  }
  for (const key of Object.keys(values))
    if (!(key in schema)) errors.push(`${key}: 未声明的参数`);
  return errors;
}
export function semanticIssues(
  def: DeviceDefinition,
  overrides: Record<string, ParamValue> = {},
) {
  const p = resolveParameters(def, overrides);
  const errors = validateParameters(def.paramsSchema, p);
  const ids = def.interfaces.map((s) => s.id);
  if (new Set(ids).size !== ids.length) errors.push("接口 ID 重复");
  if (new Set(def.behaviors.map((b) => b.id)).size !== def.behaviors.length)
    errors.push("行为 ID 重复");
  for (const b of def.behaviors)
    for (const id of b.requiredInterfaces)
      if (!ids.includes(id)) errors.push(`${b.id}: 缺少接口 ${id}`);
  for (const [key, spec] of Object.entries(def.paramsSchema))
    if (
      spec.required_when &&
      !(spec.required_when.parameter in def.paramsSchema)
    )
      errors.push(`${key}: required_when 引用不存在`);
  if (
    typeof p.resume_threshold === "number" &&
    typeof p.capacity === "number" &&
    p.resume_threshold >= p.capacity
  )
    errors.push("resume_threshold 必须小于 capacity");
  if (
    typeof p.min_height_m === "number" &&
    typeof p.max_height_m === "number" &&
    p.min_height_m >= p.max_height_m
  )
    errors.push("最小高度必须小于最大高度");
  const walk = (obj: unknown, path: string) => {
    if (!obj || typeof obj !== "object") return;
    for (const [key, v] of Object.entries(obj)) {
      if (
        key.endsWith("_param") &&
        typeof v === "string" &&
        !(v in def.paramsSchema)
      )
        errors.push(`${path}.${key}: 参数引用 ${v} 不存在`);
      if (typeof v === "object") walk(v, `${path}.${key}`);
    }
  };
  walk(def.typeSpecificContract, "type_specific_contract");
  const spatial = def.spatialInterfaces ?? [];
  if (new Set(spatial.map((i) => i.interface_id)).size !== spatial.length)
    errors.push("空间接口 ID 重复");
  for (const i of spatial) {
    walk(i.local_frame_rule, i.interface_id);
    if (i.local_frame_rule) {
      let current: unknown = {
        type_specific_contract: def.typeSpecificContract,
      };
      for (const key of i.local_frame_rule.origin_ref.split("."))
        current =
          current && typeof current === "object" && Object.hasOwn(current, key)
            ? (current as Record<string, unknown>)[key]
            : undefined;
      if (!current || typeof current !== "object")
        errors.push(`${i.interface_id}: 坐标来源不存在`);
    }
  }
  for (const [key, spec] of Object.entries(def.paramsSchema)) {
    if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max)
      errors.push(`${key}: min 大于 max`);
    if (spec.default !== undefined)
      errors.push(
        ...validateParameters({ [key]: spec }, { [key]: spec.default }),
      );
    if (spec.type === "enum" && !spec.options?.length)
      errors.push(`${key}: 缺少枚举选项`);
  }
  for (const b of def.behaviors) {
    if (["observer", "internal", "passive"].includes(b.kind) && b.schedulable)
      errors.push(`${b.id}: 此行为类型不可调度`);
    if (b.completionMode === "observed" && !b.completionChecks.length)
      errors.push(`${b.id}: 缺少完成观测`);
    for (const c of [
      ...b.preconditions,
      ...(b.sustainingConditions ?? []),
      ...b.completionChecks,
    ])
      if (c.source === "parameter" && !(c.key in def.paramsSchema))
        errors.push(`${b.id}: 条件参数不存在 ${c.key}`);
  }
  if (
    p.allow_reverse === false &&
    typeof p.speed_mps === "number" &&
    p.speed_mps < 0
  )
    errors.push("当前设备不允许反转");

  return errors;
}
export function parseProject(raw: unknown) {
  const project = projectSchema.parse(raw);
  const unique = (ids: string[], label: string) => {
    if (new Set(ids).size !== ids.length) throw new Error(`${label} ID 重复`);
  };
  unique(
    project.instances.map((i) => i.instanceId),
    "实例",
  );
  unique(
    project.definitions.map((d) => d.specId),
    "定义",
  );
  unique(
    project.assets.map((a) => a.id),
    "资源",
  );
  for (const def of project.definitions) {
    const errors = semanticIssues(def);
    if (errors.length) throw new Error(`${def.name}: ${errors.join("；")}`);
  }
  for (const i of project.instances) {
    const def = project.definitions.find(
      (d) => d.specId === i.specId && d.revision === i.specRevision,
    );
    if (!def) throw new Error(`${i.name}: 设备定义或版本不存在`);
    const errors = semanticIssues(def, i.paramOverrides);
    if (errors.length) throw new Error(`${i.name}: ${errors.join("；")}`);
  }
  const used = new Set<string>();
  unique(
    (project.connections ?? []).map((c) => c.id),
    "连接",
  );
  for (const c of project.connections ?? []) {
    if (c.a.instanceId === c.b.instanceId) throw new Error("不能连接设备自身");
    for (const end of [c.a, c.b]) {
      const i = project.instances.find((i) => i.instanceId === end.instanceId);
      const d = project.definitions.find((d) => d.specId === i?.specId);
      if (
        !d?.spatialInterfaces?.some((p) => p.interface_id === end.interfaceId)
      )
        throw new Error("连接引用不存在");
      const key = `${end.instanceId}/${end.interfaceId}`;
      if (used.has(key)) throw new Error("接口已连接");
      used.add(key);
    }
  }
  return project;
}

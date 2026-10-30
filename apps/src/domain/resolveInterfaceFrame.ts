import type { SpatialInterface } from "@/contracts/spatial";
import type { DeviceDefinition, ParamValue, Vec3 } from "@/contracts/device";
export function resolveInterfaceFrame(
  port: SpatialInterface,
  definition: DeviceDefinition,
  params: Record<string, ParamValue>,
): { position: Vec3; forward: Vec3; up: Vec3 } | null {
  if (port.local_frame) return port.local_frame;
  if (port.local_frame_pending) return null;
  const rule = port.local_frame_rule;
  if (!rule) throw new Error("接口没有坐标来源");
  let current: unknown = {
    type_specific_contract: definition.typeSpecificContract,
  };
  for (const key of rule.origin_ref.split("."))
    current =
      current && typeof current === "object" && Object.hasOwn(current, key)
        ? (current as Record<string, unknown>)[key]
        : undefined;
  if (!current || typeof current !== "object")
    throw new Error("接口原点不存在");
  const origin = current as Record<string, unknown>;
  const n = (v: unknown) => {
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error("接口坐标参数缺失");
    return v;
  };
  const p: Vec3 = [n(origin.x), n(params[rule.height_param]), n(origin.z)];
  const offset = n(params[rule.offset_param]) * rule.offset_factor;
  for (let i = 0; i < 3; i++) p[i] += rule.offset_axis[i] * offset;
  return { position: p, forward: rule.forward, up: rule.up };
}

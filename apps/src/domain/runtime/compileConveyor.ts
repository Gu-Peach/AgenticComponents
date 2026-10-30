import { Euler, Quaternion, Vector3 } from "three";
import type {
  DeviceDefinition,
  DeviceInstance,
  Vec3,
} from "@/contracts/device";
import type { CompiledRuntimeScene } from "@/contracts/runtime";
import profile from "@/data/runtime-fixtures/conveyor-calibration.json";
import { resolveParameters, semanticIssues } from "@/validation/contracts";
import { compileMaterial } from "./compileMaterial";
export function compileConveyor(
  def: DeviceDefinition,
  instance: DeviceInstance,
  revision: number,
): CompiledRuntimeScene {
  if (
    def.template ||
    def.deviceType !== "conveyor" ||
    def.source?.contract_version !== "1.2"
  )
    throw new Error(
      "请从公共资产添加新版可执行传送带（契约 1.2）；旧项目定义不会自动升级",
    );
  const execution = def.source?.runtime_execution_contract as
    Record<string, unknown> | undefined;
  if (
    execution?.template_ref !== "conveyor.continuous-contact@1" ||
    execution.calibration_ref !== profile.id
  )
    throw new Error("执行模板或标定引用不支持");
  const p = resolveParameters(def, instance.paramOverrides),
    errors = semanticIssues(def, instance.paramOverrides);
  if (errors.length) throw new Error(errors.join("；"));
  const imported = def.asset.importTransform;
  if (
    instance.transform.rotation[0] ||
    instance.transform.rotation[2] ||
    instance.transform.scale.some((n) => n !== 1) ||
    (imported &&
      ([...imported.position, ...imported.rotation].some((n) => n !== 0) ||
        imported.scale.some((n) => n !== 1)))
  )
    throw new Error("首期实验仅支持水平、单位缩放和无导入偏移的传送带");
  if (p.transport_mode !== "continuous" || p.allow_reverse !== false)
    throw new Error("首期只支持单向整带运行");
  const number = (key: string) => {
    const v = p[key];
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error(`参数缺失 ${key}`);
    return v;
  };
  const material = compileMaterial(),
    yaw = instance.transform.rotation[1],
    q = new Quaternion().setFromEuler(new Euler(0, yaw, 0));
  const world = (v: Vec3) =>
    new Vector3(...v)
      .applyQuaternion(q)
      .add(new Vector3(...instance.transform.position))
      .toArray() as Vec3;
  return {
    instanceId: instance.instanceId,
    subjectId: `${instance.instanceId}/experiment-box`,
    revision,
    templateId: "conveyor.continuous-contact",
    physics: {
      surfacePosition: world([
        0.0005,
        number("surface_height_m") - profile.surfaceThickness / 2,
        0,
      ]),
      rotation: q.toArray(),
      surfaceSize: [
        number("length_m"),
        profile.surfaceThickness,
        number("width_m"),
      ],
      materialPosition: world(material.position),
      materialSize: material.size,
      mass: material.mass,
      friction: profile.friction,
    },
    speed: number("speed_mps"),
    referenceSpeed: profile.referenceSpeed,
    accelTime: number("accel_time_s"),
    decelTime: number("decel_time_s"),
    origin: instance.transform.position,
    yaw,
    entry: profile.entryRegion as [number, number],
    regionHeight: profile.regionHeight as [number, number],
    speedTolerance: profile.speedTolerance,
    exit: profile.exitRegion as [number, number],
    timeout: profile.timeout,
  };
}

import { Vector3, Quaternion, Euler } from "three";
import type { ProjectDocument, Vec3 } from "@/contracts/device";
import type { CompiledRuntimeScene } from "@/contracts/runtime";
import { compileRigidBody } from "./compileRigidBody";
import { resolveParameters } from "@/validation/contracts";
import { conveyorModelSchema } from "@/contracts/conveyor";
import profile from "@/data/runtime-fixtures/conveyor-calibration.json";
export function compileDeclarativeScene(
  project: ProjectDocument,
  conveyorId: string,
  materialId: string,
): CompiledRuntimeScene {
  const belt = project.instances.find((i) => i.instanceId === conveyorId),
    cargo = project.instances.find((i) => i.instanceId === materialId);
  const bd = project.definitions.find((d) => d.specId === belt?.specId),
    md = project.definitions.find((d) => d.specId === cargo?.specId);
  if (
    !belt ||
    !cargo ||
    !bd ||
    !md ||
    !belt.visible ||
    !cargo.visible ||
    bd.deviceType !== "conveyor" ||
    md.deviceType !== "workpiece" ||
    bd.source?.contract_version !== "1.3" ||
    md.source?.contract_version !== "1.3"
  )
    throw new Error("请选择契约1.3的可见传送带与真实物料");
  const b = compileRigidBody(bd, belt),
    c = compileRigidBody(md, cargo);
  if (b.body.motionType !== "static" || c.body.motionType !== "dynamic")
    throw new Error("当前运输需要静态输送面和动态物料");
  const model = conveyorModelSchema.parse(bd.typeSpecificContract),
    surface = model.conveying_surface;
  if (`${belt.instanceId}/${surface.body_ref}` !== b.body.id)
    throw new Error("输送面刚体绑定无效");
  const q = new Quaternion(...b.body.rotation),
    surfaceQ = new Quaternion()
      .setFromEuler(new Euler(...belt.transform.rotation))
      .multiply(
        new Quaternion().setFromEuler(
          new Euler(...(bd.asset.importTransform?.rotation ?? [0, 0, 0])),
        ),
      ),
    flow = new Vector3(...surface.flow_axis)
      .applyQuaternion(surfaceQ)
      .normalize(),
    normal = new Vector3(...surface.normal)
      .applyQuaternion(surfaceQ)
      .normalize();
  if (
    Math.abs(surface.flow_axis[0] - 1) > 1e-6 ||
    Math.abs(surface.normal[1] - 1) > 1e-6
  )
    throw new Error("当前工艺区域仅支持设备局部 +X 流向和 +Y 法向");
  if (Math.abs(normal.y - 1) > 1e-5 || Math.abs(flow.y) > 1e-5)
    throw new Error("当前运输仅支持水平输送面");
  if (
    new Vector3(0, 1, 0).applyQuaternion(q).dot(normal) < 0.99999 ||
    Math.abs(new Vector3(1, 0, 0).applyQuaternion(q).dot(flow)) < 0.99999
  )
    throw new Error("输送面声明与盒形碰撞体方向不一致");
  // Surface axes are authored in the device frame; this baseline has identity body rotation.
  if (belt.transform.rotation[0] || belt.transform.rotation[2])
    throw new Error("当前运输仅支持水平设备");
  const localDelta = new Vector3(...c.body.position)
    .sub(new Vector3(...b.body.position))
    .applyQuaternion(q.clone().invert());
  const relativeQ = q
    .clone()
    .invert()
    .multiply(new Quaternion(...c.body.rotation));
  const half = new Vector3(...c.body.size).multiplyScalar(0.5);
  const corners: Vector3[] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1])
      for (const z of [-1, 1])
        corners.push(
          new Vector3(x * half.x, y * half.y, z * half.z).applyQuaternion(
            relativeQ,
          ),
        );
  const extent = (axis: "x" | "z") =>
    Math.max(...corners.map((v) => Math.abs(v[axis])));
  if (
    extent("z") * 2 > b.body.size[2] + 1e-6 ||
    Math.abs(localDelta.z) + extent("z") > b.body.size[2] / 2 + 1e-6 ||
    Math.abs(localDelta.x) + extent("x") > b.body.size[0] / 2 + 0.001
  )
    throw new Error("物料外形或位置超出输送面，请调整朝向/尺寸或放到入口");
  const band = (purpose: string) => {
    const region = model.observation_regions.find((r) => r.purpose === purpose);
    if (region?.geometry?.kind !== "longitudinal_band")
      throw new Error("观测区域缺少显式区间");
    return region.geometry.axis_range;
  };
  const p = resolveParameters(bd, belt.paramOverrides),
    n = (k: string) => Number(p[k]);
  if (p.allow_reverse !== false || p.transport_mode !== "continuous")
    throw new Error("当前仅支持单向整带");
  return {
    instanceId: belt.instanceId,
    subjectId: cargo.instanceId,
    materialInstanceId: cargo.instanceId,
    bodyLocalMatrix: c.bodyLocal.toArray(),
    revision: project.revision,
    templateId: "conveyor.continuous-contact",
    physics: {
      surfacePosition: b.body.position,
      rotation: b.body.rotation,
      surfaceSize: b.body.size,
      materialPosition: c.body.position,
      materialSize: c.body.size,
      mass: c.body.mass!,
      friction: b.body.friction,
      bodies: [
        b.body,
        c.body,
        {
          id: "world/ground",
          instanceId: "world",
          motionType: "static",
          role: "ground",
          position: [
            belt.transform.position[0],
            -0.05,
            belt.transform.position[2],
          ],
          rotation: [0, 0, 0, 1],
          size: [20, 0.1, 20],
          friction: 0.6,
          restitution: 0,
        },
      ],
      surfaces: [
        {
          id: surface.surface_id,
          bodyId: b.body.id,
          direction: flow.toArray() as Vec3,
          normal: normal.toArray() as Vec3,
        },
      ],
      targetBodyId: c.body.id,
    },
    speed: n("speed_mps"),
    referenceSpeed: profile.referenceSpeed,
    accelTime: n("accel_time_s"),
    decelTime: n("decel_time_s"),
    origin: belt.transform.position,
    yaw: belt.transform.rotation[1],
    entry: band("entry_availability"),
    regionHeight: [
      n("surface_height_m") - 0.01,
      n("surface_height_m") + c.body.size[1] + 0.05,
    ],
    speedTolerance: profile.speedTolerance,
    exit: band("exit_arrival"),
    timeout: profile.timeout,
  };
}

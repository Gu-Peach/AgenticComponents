import { Matrix4, Quaternion, Vector3 } from "three";
import { rigidPhysicsSchema } from "@/contracts/rigid-body";
import type {
  DeviceDefinition,
  DeviceInstance,
  Vec3,
} from "@/contracts/device";
import type { RuntimeBody, Quat } from "@/contracts/physics";
import { resolveParameters, semanticIssues } from "@/validation/contracts";
import { identityTransform, matrixOf } from "@/domain/spatial/transforms";
export function compileRigidBody(
  def: DeviceDefinition,
  instance: DeviceInstance,
  allowDraft = false,
): { body: RuntimeBody; bodyLocal: Matrix4 } {
  const errors = semanticIssues(def, instance.paramOverrides, allowDraft);
  if (errors.length) throw new Error(errors.join("；"));
  const imported = def.asset.importTransform ?? identityTransform;
  if ([...instance.transform.scale, ...imported.scale].some((n) => n !== 1))
    throw new Error("刚体运行仅支持单位缩放");
  const physics = rigidPhysicsSchema.parse(def.typeSpecificContract.physics);
  if (physics.bodies.length !== 1)
    throw new Error("当前设备编译只支持一个声明刚体");
  const b = physics.bodies[0];
  if (b.motion_type === "kinematic")
    throw new Error("运动学刚体控制能力尚未接入");
  const p = resolveParameters(def, instance.paramOverrides),
    num = (key: string) => {
      const n = p[key];
      if (typeof n !== "number" || !Number.isFinite(n))
        throw new Error(`物理参数缺失 ${key}`);
      return n;
    };
  for (const key of [
    b.collider.length_param,
    b.collider.height_param,
    b.collider.width_param,
  ])
    if (def.paramsSchema[key]?.unit !== "m")
      throw new Error("碰撞尺寸参数必须使用 m");
  if (b.mass_param && def.paramsSchema[b.mass_param]?.unit !== "kg")
    throw new Error("质量参数必须使用 kg");
  const size: Vec3 = [
    num(b.collider.length_param),
    num(b.collider.height_param),
    num(b.collider.width_param),
  ];
  if (size.some((n) => n <= 0)) throw new Error("碰撞尺寸必须为正数");
  const position = new Vector3(...b.local_pose.position);
  if (b.local_pose.surface_height_param) {
    if (!b.local_pose.thickness_param) throw new Error("缺少带面厚度引用");
    position.y +=
      num(b.local_pose.surface_height_param) -
      num(b.local_pose.thickness_param) / 2;
  }
  const local = new Matrix4().compose(
    position,
    new Quaternion(...b.local_pose.rotation_quaternion),
    new Vector3(1, 1, 1),
  );
  const binding = matrixOf(imported).multiply(local);
  const world = matrixOf(instance.transform).multiply(binding);
  const pos = new Vector3(),
    q = new Quaternion();
  world.decompose(pos, q, new Vector3());
  const material = physics.contact_materials[b.contact_material_ref],
    friction = num(material.friction_param),
    restitution = num(material.restitution_param),
    mass =
      b.mass_param && (!allowDraft || p[b.mass_param] !== undefined)
        ? num(b.mass_param)
        : undefined;
  if (
    friction < 0 ||
    restitution < 0 ||
    restitution > 1 ||
    (!allowDraft && b.motion_type === "dynamic" && (!mass || mass <= 0))
  )
    throw new Error("无效质量或接触属性");
  return {
    body: {
      id: `${instance.instanceId}/${b.body_id}`,
      instanceId: instance.instanceId,
      motionType: b.motion_type,
      role: b.role,
      position: pos.toArray() as Vec3,
      rotation: q.toArray() as Quat,
      size,
      mass,
      friction,
      restitution,
    },
    bodyLocal: binding,
  };
}

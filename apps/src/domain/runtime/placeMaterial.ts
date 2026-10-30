import { Quaternion, Vector3 } from "three";
import type { ProjectDocument, Vec3 } from "@/contracts/device";
import { compileRigidBody } from "./compileRigidBody";
import { bodyVisualPose } from "./bodyVisualPose";
export function placeMaterial(
  project: ProjectDocument,
  beltId: string,
  materialId: string,
) {
  const b = project.instances.find((i) => i.instanceId === beltId),
    m = project.instances.find((i) => i.instanceId === materialId),
    bd = project.definitions.find((d) => d.specId === b?.specId),
    md = project.definitions.find((d) => d.specId === m?.specId);
  if (!b || !m || !bd || !md) throw new Error("设备或物料不存在");
  const belt = compileRigidBody(bd, b),
    cargo = compileRigidBody(md, m, true);
  if (
    cargo.body.size[2] > belt.body.size[2] ||
    cargo.body.size[0] + 0.04 > belt.body.size[0]
  )
    throw new Error("物料尺寸无法放入带面");
  const q = new Quaternion(...belt.body.rotation);
  const point = new Vector3(
    -belt.body.size[0] / 2 + cargo.body.size[0] / 2 + 0.02,
    belt.body.size[1] / 2 + cargo.body.size[1] / 2 + 0.005,
    0,
  )
    .applyQuaternion(q)
    .add(new Vector3(...belt.body.position));
  return bodyVisualPose(
    {
      position: point.toArray() as Vec3,
      rotation: belt.body.rotation,
      velocity: [0, 0, 0],
    },
    cargo.bodyLocal.toArray(),
  );
}

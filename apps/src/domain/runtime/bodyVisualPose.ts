import { Matrix4, Quaternion, Vector3, Euler } from "three";
import type { BodyPose } from "@/contracts/physics";
import type { Transform, Vec3 } from "@/contracts/device";
export function bodyVisualPose(pose: BodyPose, bodyLocal: number[]): Transform {
  const world = new Matrix4()
    .compose(
      new Vector3(...pose.position),
      new Quaternion(...pose.rotation),
      new Vector3(1, 1, 1),
    )
    .multiply(new Matrix4().fromArray(bodyLocal).invert());
  const p = new Vector3(),
    q = new Quaternion(),
    scale = new Vector3();
  world.decompose(p, q, scale);
  return {
    position: p.toArray() as Vec3,
    rotation: new Euler().setFromQuaternion(q).toArray().slice(0, 3) as Vec3,
    scale: scale.toArray() as Vec3,
  };
}

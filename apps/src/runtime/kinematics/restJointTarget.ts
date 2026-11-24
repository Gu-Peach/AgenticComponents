/** 用正运动学校验回位目标是否与模型零位的工具位姿一致，校验通过后返回各关节的零角度。 */

import { Quaternion, Vector3 } from "three";
import type { CompiledRobotScene } from "@/contracts/robot";
import type { BodyPose } from "@/contracts/physics";
import { RobotKinematics } from "./RobotKinematics";

/** A GLB rest-pose location names a particular joint configuration as well as a TCP pose. */
export function restJointTarget(
  scene: CompiledRobotScene,
  target: Pick<BodyPose, "position" | "rotation">,
): number[] {
  const q = scene.model.urdf.joints.map(() => 0);
  const rest = new RobotKinematics(scene).forward(q).tcp;
  if (
    new Vector3(...target.position).distanceTo(new Vector3(...rest.position)) >
      scene.tolerance ||
    new Quaternion(...target.rotation).angleTo(
      new Quaternion(...rest.rotation),
    ) > 0.005
  ) {
    throw new Error(
      "回位目标与模型的零位 TCP 位姿不一致，请核对法兰绑定和工具偏移",
    );
  }
  return q;
}

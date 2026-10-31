import { Matrix4, Quaternion, Vector3 } from "three";
import type { CompiledRobotScene } from "@/contracts/robot";
import type { BodyPose } from "@/contracts/physics";
export class RobotKinematics {
  constructor(readonly scene: CompiledRobotScene) {}
  forward(q: readonly number[]) {
    if (q.length !== 6 || q.some((n) => !Number.isFinite(n)))
      throw new Error("无效关节角");
    const world = new Matrix4().compose(
      new Vector3(...this.scene.base.position),
      new Quaternion(...this.scene.base.rotation),
      new Vector3(1, 1, 1),
    );
    const joints = this.scene.model.urdf.joints.map((j, i) => {
      world.multiply(
        new Matrix4().compose(
          new Vector3(...j.rest_position),
          new Quaternion(...j.rest_quaternion),
          new Vector3(1, 1, 1),
        ),
      );
      const pivot = new Vector3().setFromMatrixPosition(world);
      const rotation = new Quaternion().setFromRotationMatrix(world);
      const axis = new Vector3(...j.axis).applyQuaternion(rotation).normalize();
      world.multiply(
        new Matrix4().makeRotationFromQuaternion(
          new Quaternion().setFromAxisAngle(new Vector3(...j.axis), q[i]),
        ),
      );
      return { pivot, axis };
    });
    const t = this.scene.model.tooling;
    world.multiply(
      new Matrix4().compose(
        new Vector3(...t.rest_position),
        new Quaternion(...t.rest_quaternion),
        new Vector3(1, 1, 1),
      ),
    );
    world.multiply(
      new Matrix4().compose(
        new Vector3(...t.tcp_local_frame.position),
        new Quaternion(...t.tcp_local_frame.rotation_quaternion),
        new Vector3(1, 1, 1),
      ),
    );
    const p = new Vector3(),
      r = new Quaternion();
    world.decompose(p, r, new Vector3());
    const tcp: BodyPose = {
      position: p.toArray(),
      rotation: r.toArray(),
      velocity: [0, 0, 0],
    };
    return { joints, tcp };
  }
  targetToWorld(
    position: [number, number, number],
    frame: "world" | "robot_base",
  ) {
    return frame === "world"
      ? new Vector3(...position)
      : new Vector3(...position)
          .applyQuaternion(new Quaternion(...this.scene.base.rotation))
          .add(new Vector3(...this.scene.base.position));
  }
}

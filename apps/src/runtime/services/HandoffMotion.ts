import { Matrix4, Quaternion, Vector3 } from "three";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import type { CompiledRobotScene } from "@/contracts/robot";
import type { Vec3 } from "@/contracts/scene-execution";
import { RobotKinematics } from "@/runtime/kinematics/RobotKinematics";
import { DampedPoseIK } from "@/runtime/kinematics/DampedPoseIK";
import { JointTrajectory } from "@/runtime/mechanisms/JointTrajectory";

export function poseMatrix(p: Pick<BodyPose, "position" | "rotation">) {
  return new Matrix4().compose(
    new Vector3(...p.position),
    new Quaternion(...p.rotation),
    new Vector3(1, 1, 1),
  );
}

export class HandoffArm {
  readonly fk: RobotKinematics;
  readonly graspId: string;
  q = [0, 0, 0, 0, 0, 0];
  qdot = [0, 0, 0, 0, 0, 0];
  private path: number[][] = [];
  private motion?: JointTrajectory;
  private braking = false;
  readonly axis: Vector3;
  readonly home: BodyPose;
  held?: string;
  relative?: Matrix4;
  constructor(
    readonly scene: CompiledRobotScene,
    axis: Vec3,
    private physics: PhysicsPort,
  ) {
    this.axis = new Vector3(...axis);
    this.fk = new RobotKinematics(scene);
    this.home = this.fk.forward(this.q).tcp;
    this.graspId = scene.instanceId + "/handoff-grasp";
  }
  get stopped() {
    return (
      !this.path.length &&
      !this.motion &&
      this.qdot.every((v) => Math.abs(v) < 1e-7) &&
      Math.hypot(...this.physics.readBody!(this.scene.toolBodyId).velocity) <
        0.015
    );
  }
  get atHome() {
    return this.q.every((v) => Math.abs(v) < 1e-6) && this.stopped;
  }
  get holding() {
    return !!this.held && !!this.physics.hasGrasp!(this.graspId);
  }
  get pose() {
    return this.physics.readBody!(this.scene.toolBodyId);
  }
  rotationFacing(direction: Vector3, roll: number) {
    const home = new Quaternion(...this.home.rotation);
    return new Quaternion()
      .setFromAxisAngle(direction, roll)
      .multiply(
        new Quaternion()
          .setFromUnitVectors(
            this.axis.clone().applyQuaternion(home),
            direction,
          )
          .multiply(home),
      );
  }
  solve(position: Vector3, rotation: Quaternion, seed = this.q) {
    const solver = new DampedPoseIK(this.fk, rotation);
    const direct = solver.solve(position, seed);
    if (
      direct.converged &&
      Math.max(...direct.q.map((v, i) => Math.abs(v - seed[i]))) < 1.8
    )
      return direct.q;
    const candidates = [...(direct.converged ? [direct.q] : [])] as number[][];
    // Try alternate elbow and shoulder configurations inside the agreed joint limits.
    for (const shoulder of [-1.5, 0, 1.5])
      for (const elbow of [-1.5, 1.5]) {
        const result = solver.solve(position, [
          shoulder,
          -elbow / 2,
          elbow,
          -elbow / 2,
          0,
          0,
        ]);
        if (result.converged) candidates.push(result.q);
      }
    const distance = (q: number[]) =>
      q.reduce((sum, v, i) => sum + (v - seed[i]) ** 2, 0);
    return candidates.sort((a, b) => distance(a) - distance(b))[0];
  }
  target(
    position: Vector3,
    rotation: Quaternion,
    label: string,
    seed = this.q,
  ) {
    const result = this.solve(position, rotation, seed);
    if (!result)
      throw new Error(
        `${this.scene.instanceId} ${label} IK 未收敛 (${position
          .toArray()
          .map((v) => v.toFixed(3))
          .join(", ")})`,
      );
    return result;
  }
  start(path: number[][]) {
    this.path = [...path];
    this.motion = undefined;
    this.braking = false;
  }
  stop() {
    this.path = [];
    this.motion = undefined;
    this.braking = true;
  }
  step(dt: number) {
    if (this.braking) {
      this.q = this.q.map((v, i) => {
        const before = this.qdot[i];
        this.qdot[i] =
          Math.sign(before) *
          Math.max(0, Math.abs(before) - this.scene.acceleration[i] * dt);
        const limit = this.scene.model.urdf.joints[i].limit,
          next = v + ((before + this.qdot[i]) * dt) / 2;
        if (!limit) return next;
        if (next < limit.lower || next > limit.upper) this.qdot[i] = 0;
        return Math.max(limit.lower, Math.min(limit.upper, next));
      });
    } else if (this.path.length) {
      this.motion ??= new JointTrajectory(
        this.q,
        this.path[0],
        this.scene.speed,
        this.scene.acceleration,
      );
      const frame = this.motion.step(dt);
      this.q = frame.q;
      this.qdot = frame.qdot;
      if (this.motion.done) {
        this.path.shift();
        this.motion = undefined;
      }
    }
    this.physics.moveTool!(
      this.scene.toolBodyId,
      this.fk.forward(this.q).tcp,
      dt,
    );
  }
  attach(material: string, pose: BodyPose) {
    this.held = material;
    this.relative = poseMatrix(this.pose).invert().multiply(poseMatrix(pose));
  }
  clear() {
    this.relative = undefined;
    this.held = undefined;
  }
}

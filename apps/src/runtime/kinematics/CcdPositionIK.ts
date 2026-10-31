import { Vector3 } from "three";
import type { PositionIK, IKResult } from "./PositionIK";
import { RobotKinematics } from "./RobotKinematics";
export class CcdPositionIK implements PositionIK {
  constructor(private fk: RobotKinematics) {}
  solve(target: Vector3, seed: readonly number[]): IKResult {
    if (!target.toArray().every(Number.isFinite))
      throw new Error("目标坐标无效");
    const scene = this.fk.scene;
    const q = [...seed];
    this.fk.forward(q);
    let error = Infinity,
      iteration = 0;
    for (; iteration < scene.iterations; iteration++) {
      error = new Vector3(...this.fk.forward(q).tcp.position).distanceTo(
        target,
      );
      if (error <= scene.tolerance) break;
      for (let i = 5; i >= 0; i--) {
        const { joints, tcp } = this.fk.forward(q),
          { pivot, axis } = joints[i];
        const a = new Vector3(...tcp.position).sub(pivot),
          b = target.clone().sub(pivot);
        a.addScaledVector(axis, -a.dot(axis));
        b.addScaledVector(axis, -b.dot(axis));
        if (a.lengthSq() < 1e-10 || b.lengthSq() < 1e-10) continue;
        a.normalize();
        b.normalize();
        const angle = Math.atan2(
          axis.dot(a.clone().cross(b)),
          Math.max(-1, Math.min(1, a.dot(b))),
        );
        const limit = scene.model.urdf.joints[i].limit;
        q[i] = Math.max(limit.lower, Math.min(limit.upper, q[i] + angle));
      }
    }
    error = new Vector3(...this.fk.forward(q).tcp.position).distanceTo(target);
    return {
      q,
      converged: error <= scene.tolerance,
      error,
      iterations: iteration,
    };
  }
}

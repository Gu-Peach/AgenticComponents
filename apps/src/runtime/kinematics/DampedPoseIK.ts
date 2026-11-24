/** 使用阻尼最小二乘法迭代求解机械臂关节角，同时约束工具中心点的位置和朝向。 */

import { Quaternion, Vector3 } from "three";
import { RobotKinematics } from "./RobotKinematics";
/** Damped spatial Jacobian solve for transfers which must retain the load orientation. */
export class DampedPoseIK {
  constructor(
    private fk: RobotKinematics,
    private rotation: Quaternion,
  ) {}
  solve(target: Vector3, seed: readonly number[]) {
    const q = [...seed],
      weight = 0.3;
    let error = Infinity,
      angle = Infinity,
      iteration = 0;
    for (; iteration < this.fk.scene.iterations; iteration++) {
      const pose = this.fk.forward(q),
        position = new Vector3(...pose.tcp.position);
      const delta = target.clone().sub(position),
        rotation = this.rotation
          .clone()
          .multiply(new Quaternion(...pose.tcp.rotation).invert())
          .normalize();
      if (rotation.w < 0)
        rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
      const axis = new Vector3(rotation.x, rotation.y, rotation.z);
      angle = 2 * Math.atan2(axis.length(), rotation.w);
      if (axis.length() > 1e-10) axis.normalize().multiplyScalar(angle);
      error = delta.length();
      if (error <= this.fk.scene.tolerance && angle <= 0.005) break;
      const residual = [
        ...delta.toArray(),
        ...axis.multiplyScalar(weight).toArray(),
      ];
      const columns = pose.joints.map((j) => [
        ...j.axis.clone().cross(position.clone().sub(j.pivot)).toArray(),
        ...j.axis.clone().multiplyScalar(weight).toArray(),
      ]);
      const rows = Array.from({ length: 6 }, (_, i) => [
        ...Array.from({ length: 6 }, (_, j) =>
          columns.reduce((s, c) => s + c[i] * c[j], i === j ? 0.000025 : 0),
        ),
        residual[i],
      ]);
      for (let k = 0; k < 6; k++) {
        let pivot = k;
        for (let i = k + 1; i < 6; i++)
          if (Math.abs(rows[i][k]) > Math.abs(rows[pivot][k])) pivot = i;
        [rows[k], rows[pivot]] = [rows[pivot], rows[k]];
        const scale = rows[k][k];
        for (let j = k; j < 7; j++) rows[k][j] /= scale;
        for (let i = 0; i < 6; i++)
          if (i !== k) {
            const factor = rows[i][k];
            for (let j = k; j < 7; j++) rows[i][j] -= factor * rows[k][j];
          }
      }
      const step = columns.map((c) =>
          c.reduce((s, v, i) => s + v * rows[i][6], 0),
        ),
        scale = Math.min(1, 0.15 / Math.max(...step.map(Math.abs)));
      for (let i = 0; i < 6; i++) {
        q[i] += step[i] * scale;
        const limit = this.fk.scene.model.urdf.joints[i].limit;
        if (limit) q[i] = Math.max(limit.lower, Math.min(limit.upper, q[i]));
      }
    }
    const actual = this.fk.forward(q).tcp;
    error = new Vector3(...actual.position).distanceTo(target);
    angle = this.rotation.angleTo(new Quaternion(...actual.rotation));
    return {
      q,
      error,
      orientationError: angle,
      iterations: iteration,
      converged: error <= this.fk.scene.tolerance && angle <= 0.005,
    };
  }
}

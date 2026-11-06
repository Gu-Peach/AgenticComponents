import { it, expect } from "vitest";
import { Quaternion, Vector3 } from "three";
import { robotSetup } from "../robot-helpers";
import { RobotKinematics } from "../../src/runtime/kinematics/RobotKinematics";
import { DampedPoseIK } from "../../src/runtime/kinematics/DampedPoseIK";
it("solves position and orientation without mutating the seed or exceeding joint limits", () => {
  const { scene } = robotSetup(),
    fk = new RobotKinematics(scene),
    seed = [0.2, 0.1, -0.1, 0.1, 0.1, -0.1],
    pose = fk.forward(seed.map((v) => v + 0.02)).tcp;
  const before = [...seed],
    target = new Quaternion(...pose.rotation),
    result = new DampedPoseIK(fk, target).solve(
      new Vector3(...pose.position),
      seed,
    );
  expect(result.converged).toBe(true);
  expect(result.orientationError).toBeLessThanOrEqual(0.005);
  expect(seed).toEqual(before);
  for (const [i, j] of scene.model.urdf.joints.entries())
    if (j.limit) {
      expect(result.q[i]).toBeGreaterThanOrEqual(j.limit.lower);
      expect(result.q[i]).toBeLessThanOrEqual(j.limit.upper);
    }
});

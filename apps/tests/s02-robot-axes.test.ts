import { readFileSync } from "node:fs";
import { Quaternion, Vector3 } from "three";
import { expect, it } from "vitest";
import { sceneBundleSchema } from "../src/contracts/scene-package";
import { compileSceneRobot } from "../src/domain/runtime/compileSceneRobot";
import { CcdPositionIK } from "../src/runtime/kinematics/CcdPositionIK";
import { RobotKinematics } from "../src/runtime/kinematics/RobotKinematics";

function bundle(id: string) {
  return sceneBundleSchema.parse(
    JSON.parse(
      readFileSync(`public/scene/${id}/.generated/scene.bundle.json`, "utf8"),
    ),
  );
}

const reference = bundle("S01");
const loading = bundle("S02");
const zero = [0, 0, 0, 0, 0, 0];
// S02 defines local +Y as positive at J2, J3 and J5.
const referenceToLoadingSign = [1, -1, -1, 1, -1, 1];

it.each(["R1", "R2", "R3"])(
  "matches the reference motion under the S02 angle convention for %s",
  (id) => {
    const model = (b: typeof reference, name: string) =>
      new RobotKinematics(
        compileSceneRobot(
          b.devices.find((d) => d.instance_id === name),
          0,
          { allowCandidate: true },
        ),
      );
    const baseline = model(reference, "R1");
    const candidate = model(loading, id);
    const home = baseline.forward(zero);
    const localHome = candidate.forward(zero);

    for (const [i, joint] of home.joints.entries()) {
      expect(
        localHome.joints[i].axis.distanceTo(
          joint.axis.clone().multiplyScalar(referenceToLoadingSign[i]),
        ),
        `${id}, joint ${i + 1}`,
      ).toBeLessThan(1e-5);
    }
    // Remove the assembly translation and fixed flange-frame difference before comparing FK motion.
    const q = [0.31, -0.49, 0.57, -0.24, 0.36, 0.41];
    const relativeMotion = (fk: RobotKinematics, angles: number[]) => {
      const rest = fk.forward(zero);
      const pose = fk.forward(angles).tcp;
      return {
        position: new Vector3(...pose.position).sub(rest.joints[0].pivot),
        rotation: new Quaternion(...pose.rotation).multiply(
          new Quaternion(...rest.tcp.rotation).invert(),
        ),
      };
    };
    const expected = relativeMotion(baseline, q);
    const actual = relativeMotion(
      candidate,
      q.map((angle, i) => angle * referenceToLoadingSign[i]),
    );
    expect(actual.position.distanceTo(expected.position)).toBeLessThan(1e-5);
    expect(actual.rotation.angleTo(expected.rotation)).toBeLessThan(1e-5);
  },
);

it("solves the observed first S02 approach from rest within the approved 5 mm tolerance", () => {
  const model = compileSceneRobot(
    loading.devices.find((d) => d.instance_id === "R1"),
    0,
    { allowCandidate: true },
  );
  const fk = new RobotKinematics(model);
  // World-space TCP target reported by the first place_lower preflight with M01_01 settled on S1B.
  const target = new Vector3(-4.057, 1.225, 2.196);
  const result = new CcdPositionIK(fk).solve(target, zero);
  expect(result.converged).toBe(true);
  expect(result.iterations).toBeLessThanOrEqual(50);
  expect(
    new Vector3(...fk.forward(result.q).tcp.position).distanceTo(target),
  ).toBeLessThanOrEqual(0.005);
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Matrix4, Vector3, Quaternion } from "three";
import { robotSetup } from "./robot-helpers";
import { RobotKinematics } from "../src/runtime/kinematics/RobotKinematics";
import { CcdPositionIK } from "../src/runtime/kinematics/CcdPositionIK";
import { JointTrajectory } from "../src/runtime/mechanisms/JointTrajectory";
import { validateRobotAsset } from "../src/domain/runtime/validateRobotAsset";
describe("robot kinematics", () => {
  it("matches source GLB zero pose, source centers and nontrivial root transform", () => {
    const { scene } = robotSetup(),
      b = readFileSync("public/modles/robot_UR10/robot_UR10.glb");
    expect(() =>
      validateRobotAsset(
        scene,
        b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      ),
    ).not.toThrow();
    expect(
      new RobotKinematics(scene).forward([0, 0, 0, 0, 0, 0]).tcp.position[1],
    ).toBeGreaterThan(0.5);
  });
  it("applies instance rotation/translation and TCP offset once", () => {
    const { scene } = robotSetup(),
      q = [0, 0, 0, 0, 0, 0],
      first = new RobotKinematics(scene).forward(q).tcp;
    const modified = structuredClone(scene);
    modified.base.position = [3, 0, -2];
    modified.base.rotation = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 1, 0), 0.7)
      .toArray();
    const second = new RobotKinematics(modified).forward(q).tcp;
    expect(
      new Vector3(...first.position)
        .applyQuaternion(new Quaternion(...modified.base.rotation))
        .add(new Vector3(3, 0, -2))
        .distanceTo(new Vector3(...second.position)),
    ).toBeLessThan(1e-8);
    modified.model.tooling.tcp_local_frame.position = [0, 0.08, 0];
    expect(
      new Vector3(
        ...new RobotKinematics(modified).forward(q).tcp.position,
      ).distanceTo(new Vector3(...second.position)),
    ).toBeCloseTo(0.08, 8);
  });
  it("solves reachable targets without modifying the input chain or seed", () => {
    const { scene } = robotSetup(),
      fk = new RobotKinematics(scene),
      solver = new CcdPositionIK(fk),
      seed = [0, 0, 0, 0, 0, 0],
      source = JSON.stringify(scene),
      target = new Vector3(
        ...fk.forward([0.2, 0.15, -0.2, 0, 0, 0]).tcp.position,
      ),
      r = solver.solve(target, seed);
    expect(r.converged).toBe(true);
    expect(r.error).toBeLessThanOrEqual(scene.tolerance);
    expect(seed).toEqual([0, 0, 0, 0, 0, 0]);
    expect(JSON.stringify(scene)).toBe(source);
  });
  it("bounds iteration count and does not accept unreachable or NaN targets", () => {
    const { scene } = robotSetup();
    scene.iterations = 3;
    const solver = new CcdPositionIK(new RobotKinematics(scene)),
      r = solver.solve(new Vector3(100, 100, 100), [0, 0, 0, 0, 0, 0]);
    expect(r.converged).toBe(false);
    expect(r.iterations).toBe(3);
    r.q.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(scene.model.urdf.joints[i].limit.lower);
      expect(v).toBeLessThanOrEqual(scene.model.urdf.joints[i].limit.upper);
    });
    expect(() => solver.solve(new Vector3(NaN, 0, 0), r.q)).toThrow();
  });
  it("respects velocity and sampled acceleration limits with synchronized endpoints", () => {
    const { scene } = robotSetup(),
      t = new JointTrajectory(
        [0, 0, 0, 0, 0, 0],
        [0.8, -0.3, 0.1, 0, 0, 0],
        scene.speed,
        scene.acceleration,
      );
    let previous = [0, 0, 0, 0, 0, 0],
      state = { q: previous, qdot: previous };
    while (!t.done) {
      state = t.step(1 / 60);
      state.qdot.forEach((v, i) => {
        expect(Math.abs(v)).toBeLessThanOrEqual(scene.speed[i] + 1e-8);
        expect(Math.abs(v - previous[i]) * 60).toBeLessThanOrEqual(
          scene.acceleration[i] + 1e-5,
        );
      });
      previous = state.qdot;
    }
    expect(state.q).toEqual([0.8, -0.3, 0.1, 0, 0, 0]);
    expect(Math.max(...state.qdot.map(Math.abs))).toBeLessThan(1e-8);
  });
});

it("matches full source GLB hierarchy after nonzero joint rotations", () => {
  const { scene } = robotSetup(),
    b = readFileSync("public/modles/robot_UR10/robot_UR10.glb"),
    g = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString()) as {
      nodes: { name: string; matrix?: number[]; children?: number[] }[];
    },
    q = [0.3, -0.2, 0.4, -0.1, 0.2, -0.4],
    jointMap = new Map(
      scene.model.urdf.joints.map((j, i) => [j.nodeName, { j, i }]),
    );
  let expected = new Vector3();
  function visit(i: number, parent: Matrix4) {
    const n = g.nodes[i],
      m = n.matrix ? new Matrix4().fromArray(n.matrix) : new Matrix4(),
      joint = jointMap.get(n.name);
    if (joint)
      m.multiply(
        new Matrix4().makeRotationFromQuaternion(
          new Quaternion().setFromAxisAngle(
            new Vector3(...joint.j.axis),
            q[joint.i],
          ),
        ),
      );
    const world = parent.clone().multiply(m);
    if (n.name === scene.model.tooling.tcp_node_name)
      expected = new Vector3().setFromMatrixPosition(world);
    for (const c of n.children ?? []) visit(c, world);
  }
  visit(0, new Matrix4());
  expect(
    expected.distanceTo(
      new Vector3(...new RobotKinematics(scene).forward(q).tcp.position),
    ),
  ).toBeLessThan(1e-5);
});

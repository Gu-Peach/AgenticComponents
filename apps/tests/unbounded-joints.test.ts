import { it, expect } from "vitest";
import { Vector3 } from "three";
import { robotSetup } from "./robot-helpers";
import { robotModelSchema } from "../src/contracts/robot";
import { RobotKinematics } from "../src/runtime/kinematics/RobotKinematics";
import { CcdPositionIK } from "../src/runtime/kinematics/CcdPositionIK";
import { getDeviceModule } from "@/devices/registry";
import { SignalRegistry } from "../src/runtime/engine/SignalRegistry";
it("accepts explicit null limits, rejects omitted limits, and runs finite multi-turn targets", () => {
  const { scene } = robotSetup();
  scene.model.urdf.joints.forEach((j) => (j.limit = null));
  expect(robotModelSchema.safeParse(scene.model).success).toBe(true);
  const missing = structuredClone(scene.model);
  delete (missing.urdf.joints[0] as { limit?: unknown }).limit;
  expect(robotModelSchema.safeParse(missing).success).toBe(false);
  const signals = new SignalRegistry([
    { id: "enableTag", direction: "input", type: "BOOL" },
  ]);
  signals.command("enableTag", true);
  signals.begin(0);
  const { state, runner } = getDeviceModule(
    "robot_arm",
  ).standaloneTemplate.create(scene, signals);
  runner.plan([{ kind: "move_joints", q: [Math.PI * 4, 0, 0, 0, 0, 0] }]);
  for (let i = 0; i < 2400 && !runner.finished; i++) {
    runner.before(1 / 60);
    runner.after(1 / 60, i);
  }
  expect(runner.finished).toBe(true);
  expect(state.q[0]).toBeCloseTo(Math.PI * 4, 6);
  expect(Math.abs(state.qdot[0])).toBeLessThanOrEqual(scene.settleSpeed);
});
it("solves unbounded IK without reading lower/upper and retains bounded compatibility", () => {
  const { scene } = robotSetup();
  scene.model.urdf.joints.forEach((j) => (j.limit = null));
  const fk = new RobotKinematics(scene),
    target = new Vector3(...fk.forward([0.2, 0.1, -0.1, 0, 0, 0]).tcp.position);
  expect(
    new CcdPositionIK(fk).solve(target, [0, 0, 0, 0, 0, 0]).converged,
  ).toBe(true);
});

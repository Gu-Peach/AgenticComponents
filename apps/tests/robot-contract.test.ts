import { describe, it, expect } from "vitest";
import { robotSetup } from "./robot-helpers";
import { compileRobotArm } from "../src/domain/runtime/compileRobotArm";
import { parseProject } from "../src/validation/contracts";
import { robotModelSchema } from "../src/contracts/robot";
import { robotCommandSchema } from "../src/contracts/robot-command";
describe("robot contracts", () => {
  it("loads and saves a simulation-labelled real model without physical arm bodies", () => {
    const { project, def, scene } = robotSetup();
    expect(parseProject(project)).toEqual(project);
    expect(def.spatialInterfaces).toEqual([]);
    expect(scene.physics).toBeUndefined();
    expect(scene.model.calibration.source).toContain("simulation");
  });
  it("rejects pending calibration, mismatched hash and non-unit outer scale", () => {
    const { def, instance } = robotSetup();
    const a = structuredClone(def);
    a.typeSpecificContract.calibration = {
      ...(a.typeSpecificContract.calibration as object),
      status: "pending",
    };
    expect(() => compileRobotArm(a, instance, 0)).toThrow("校准");
    const b = structuredClone(def);
    b.asset.sha256 = "0".repeat(64);
    expect(() => compileRobotArm(b, instance, 0)).toThrow("哈希");
    instance.transform.scale = [2, 2, 2];
    expect(() => compileRobotArm(def, instance, 0)).toThrow("缩放");
  });
  it("rejects duplicate/broken chains and nonnormalized axes", () => {
    const { def, instance, scene } = robotSetup();
    const m = structuredClone(scene.model);
    m.urdf.joints[2].parent_joint = "joint_5";
    def.typeSpecificContract = m;
    expect(() => compileRobotArm(def, instance, 0)).toThrow("关节链");
    m.urdf.joints[0].axis = [0, 2, 0];
    expect(() => robotModelSchema.parse(m)).toThrow();
  });
  it("validates typed payloads and DINT request IDs", () => {
    expect(() =>
      robotCommandSchema.parse({
        requestId: 1,
        instanceId: "r",
        behaviorId: "move_to_pose",
        steps: [{ kind: "move_to_pose", position: [0, 1, 2], frame: "world" }],
      }),
    ).not.toThrow();
    expect(() =>
      robotCommandSchema.parse({
        requestId: 1.5,
        instanceId: "r",
        behaviorId: "move_joints",
        steps: [],
      }),
    ).toThrow();
  });
});

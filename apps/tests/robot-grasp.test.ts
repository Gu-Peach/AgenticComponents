import { readFileSync } from "node:fs";
import { robotSetup } from "./robot-helpers";
import { normalizeDeviceSpec } from "../src/domain/normalizeDeviceSpec";
import { instantiate } from "../src/domain/catalog";
import { compileRobotExperiment } from "../src/domain/runtime/compileRobotExperiment";
import { RuntimeKernel } from "../src/runtime/engine/RuntimeKernel";
import { RobotKinematics } from "../src/runtime/kinematics/RobotKinematics";
import { describe, it, expect } from "vitest";
import { createJoltBackend } from "../src/runtime/physics/jolt/JoltPhysicsBackend";
import type { PhysicsConfig, BodyPose } from "../src/contracts/physics";
function config(): PhysicsConfig {
  return {
    surfacePosition: [0, -0.05, 0],
    surfaceSize: [4, 0.1, 4],
    rotation: [0, 0, 0, 1],
    materialPosition: [0, 0.1, 0],
    materialSize: [0.2, 0.2, 0.2],
    mass: 1,
    friction: 0.6,
    targetBodyId: "cargo",
    bodies: [
      {
        id: "support",
        instanceId: "table",
        motionType: "static",
        role: "conveying_support",
        position: [0, -0.05, 0],
        rotation: [0, 0, 0, 1],
        size: [4, 0.1, 4],
        friction: 0.6,
        restitution: 0,
      },
      {
        id: "cargo",
        instanceId: "cargo",
        motionType: "dynamic",
        role: "material",
        position: [0, 0.1, 0],
        rotation: [0, 0, 0, 1],
        size: [0.2, 0.2, 0.2],
        mass: 1,
        friction: 0.6,
        restitution: 0,
      },
      {
        id: "tool",
        instanceId: "robot",
        motionType: "kinematic",
        role: "tool",
        position: [0, 0.23, 0],
        rotation: [0, 0, 0, 1],
        size: [0.025, 0.025, 0.025],
        friction: 0.6,
        restitution: 0,
      },
    ],
    surfaces: [
      { id: "top", bodyId: "support", direction: [1, 0, 0], normal: [0, 1, 0] },
    ],
  };
}
describe("Jolt fixed grasp", () => {
  it("creates without teleport, follows a kinematic tool and falls onto support after release", async () => {
    const p = await createJoltBackend(config());
    try {
      for (let i = 0; i < 10; i++) p.step(1 / 60);
      const before = p.readMaterial();
      p.createGrasp!("grip", "tool", "cargo");
      expect(p.readMaterial()).toEqual(before);
      expect(p.hasGrasp!("grip")).toBe(true);
      expect(() => p.createGrasp!("other", "tool", "cargo")).toThrow();
      for (let i = 1; i <= 90; i++) {
        const t: BodyPose = {
          position: [i / 300, 0.23 + i / 150, 0],
          rotation: [0, 0, 0, 1],
          velocity: [0, 0, 0],
        };
        p.moveTool!("tool", t, 1 / 60);
        p.step(1 / 60);
      }
      const lifted = p.readMaterial();
      expect(lifted.position[0]).toBeCloseTo(0.3, 2);
      expect(lifted.position[1]).toBeGreaterThan(0.65);
      p.removeGrasp!("grip");
      expect(p.hasGrasp!("grip")).toBe(false);
      p.moveTool!(
        "tool",
        {
          position: [0.3, 1.5, 0],
          rotation: [0, 0, 0, 1],
          velocity: [0, 0, 0],
        },
        1 / 60,
      );
      for (let i = 0; i < 150; i++) p.step(1 / 60);
      expect(p.readMaterial().position[1]).toBeCloseTo(0.1, 2);
      expect(p.hasSupport("cargo", "top")).toBe(true);
    } finally {
      p.dispose();
      p.dispose();
    }
  });
  it("rejects illegal pairs and cleans up an active constraint", async () => {
    const p = await createJoltBackend(config());
    expect(() => p.createGrasp!("bad", "cargo", "support")).toThrow();
    p.createGrasp!("ok", "tool", "cargo");
    p.dispose();
    expect(p.hasGrasp!("ok")).toBe(false);
    expect(() => p.readMaterial()).toThrow();
  });
});

it("runs actual robot FK/IK and engine_block fixed-grasp job through support confirmation", async () => {
  const { project, scene } = robotSetup(),
    load = (name: string) =>
      normalizeDeviceSpec(
        JSON.parse(readFileSync(`public/modles/${name}/schema.json`, "utf8")),
      ),
    belt = load("Conveyor_aankws"),
    material = load("engine_block"),
    a = instantiate(belt, 1),
    b = instantiate(material, 2);
  a.instanceId = "belt";
  b.instanceId = "block";
  const tcp = new RobotKinematics(scene).forward([0, 0, 0, 0, 0, 0]).tcp
    .position;
  a.transform.position = [tcp[0] - 0.0005, 0, tcp[2]];
  b.transform.position = [tcp[0] - 0.12, 0.7, tcp[2]];
  b.transform.rotation = [0, Math.PI / 2, 0];
  b.paramOverrides.mass_kg = 1;
  project.definitions.push(belt, material);
  project.instances.push(a, b);
  const before = JSON.stringify(project),
    c = compileRobotExperiment(project, "robot", {
      materialId: "block",
      supportId: "belt",
    }),
    physics = await createJoltBackend(c.physics!),
    k = new RuntimeKernel(c, physics);
  try {
    for (let i = 0; i < 30; i++) k.step(1 / 60);
    k.submitAction(k.pickPlaceCommand(10));
    let held = false;
    for (let i = 0; i < 3600; i++) {
      const snap = k.step(1 / 60);
      held ||= !!snap.robot?.holdingMaterialId;
      if (snap.request?.status !== "busy") break;
    }
    expect(held).toBe(true);
    expect(k.snapshot().request, JSON.stringify(k.snapshot())).toMatchObject({
      status: "succeeded",
    });
    expect(k.snapshot().robot?.holdingMaterialId).toBeNull();
    expect(JSON.stringify(project)).toBe(before);
  } finally {
    k.stop();
  }
});

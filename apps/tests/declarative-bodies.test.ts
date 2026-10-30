import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeDeviceSpec } from "../src/domain/normalizeDeviceSpec";
import { instantiate } from "../src/domain/catalog";
import { compileDeclarativeScene } from "../src/domain/runtime/compileDeclarativeScene";
import { placeMaterial } from "../src/domain/runtime/placeMaterial";
import { bodyVisualPose } from "../src/domain/runtime/bodyVisualPose";
import { compileRigidBody } from "../src/domain/runtime/compileRigidBody";
import { parseProject, semanticIssues } from "../src/validation/contracts";
import { createJoltBackend } from "../src/runtime/physics/jolt/JoltPhysicsBackend";
import { RuntimeKernel } from "../src/runtime/engine/RuntimeKernel";
import { SimulationSession } from "../src/runtime/engine/SimulationSession";
import type { ProjectDocument } from "../src/contracts/device";
const load = (name: string) =>
  normalizeDeviceSpec(
    JSON.parse(readFileSync(`public/modles/${name}/schema.json`, "utf8")),
  );
function setup(mass?: number) {
  const belt = load("Conveyor_aankws"),
    material = load("engine_block"),
    a = instantiate(belt, 0),
    b = instantiate(material, 1);
  a.instanceId = "belt";
  b.instanceId = "block";
  a.transform.position = [0, 0, 0];
  if (mass !== undefined) b.paramOverrides.mass_kg = mass;
  const project: ProjectDocument = {
    format: "agentic-workbench",
    version: 1,
    id: "bodies",
    name: "bodies",
    revision: 0,
    definitions: [belt, material],
    instances: [a, b],
    assets: [],
    plc: "",
  };
  b.transform = placeMaterial(project, a.instanceId, b.instanceId);
  return { project, belt, material, a, b };
}
describe("declarative bodies", () => {
  it("loads a mass-less draft and refuses running until the instance supplies mass", () => {
    const { project, a, b, material } = setup();
    expect(parseProject(project)).toEqual(project);
    expect(semanticIssues(material)).toContain("mass_kg: 必填参数缺失");
    expect(() =>
      compileDeclarativeScene(project, a.instanceId, b.instanceId),
    ).toThrow("mass_kg");
    b.paramOverrides.mass_kg = 5;
    expect(
      compileDeclarativeScene(project, a.instanceId, b.instanceId).physics.mass,
    ).toBe(5);
  });
  it("projects the body center back to the GLB bottom origin, including rotation", () => {
    const { material, b } = setup(5);
    b.transform = {
      position: [1, 0.7, 2],
      rotation: [0, 0, Math.PI / 2],
      scale: [1, 1, 1],
    };
    const compiled = compileRigidBody(material, b),
      pose = bodyVisualPose(
        { ...compiled.body, velocity: [0, 0, 0] },
        compiled.bodyLocal.toArray(),
      );
    expect(pose.position[0]).toBeCloseTo(1);
    expect(pose.position[1]).toBeCloseTo(0.7);
    expect(pose.rotation[2]).toBeCloseTo(Math.PI / 2);
  });
  it("transports the real material by registered contact and preserves author state", async () => {
    const { project, a, b } = setup(5),
      source = JSON.stringify(project),
      c = compileDeclarativeScene(project, a.instanceId, b.instanceId),
      p = await createJoltBackend(c.physics),
      k = new RuntimeKernel(c, p),
      s = new SimulationSession(k);
    try {
      k.tasks.submit("arrive", b.instanceId);
      k.signals.command("runTag", true);
      s.start();
      for (let i = 0; i < 240; i++) s.step(1 / 60);
      expect(s.snapshot().request?.status).toBe("succeeded");
      const visual = bodyVisualPose(s.snapshot().pose!, c.bodyLocalMatrix!);
      expect(visual.position[1]).toBeCloseTo(0.7, 2);
      expect(JSON.stringify(project)).toBe(source);
    } finally {
      s.stop();
    }
  });
  it("keeps contact ownership separate for two materials and clears it after leaving", async () => {
    const { project, a, b } = setup(5),
      c = compileDeclarativeScene(project, a.instanceId, b.instanceId);
    const outside = structuredClone(c.physics.bodies![1]);
    outside.id = "other/material";
    outside.instanceId = "other";
    outside.position[2] = 2;
    c.physics.bodies!.push(outside);
    const p = await createJoltBackend(c.physics);
    try {
      p.setSurfaceSpeed(0.4);
      for (let i = 0; i < 60; i++) p.step(1 / 60);
      expect(p.hasSupport(c.physics.targetBodyId)).toBe(true);
      expect(p.hasSupport(outside.id)).toBe(false);
      expect(p.readBody!(outside.id).position[0]).toBeCloseTo(
        outside.position[0],
        2,
      );
      for (let i = 0; i < 300; i++) p.step(1 / 60);
      expect(p.hasSupport(c.physics.targetBodyId)).toBe(false);
    } finally {
      p.dispose();
    }
  });
  it("uses world direction after rotating the conveyor", async () => {
    const { project, a, b } = setup(5);
    a.transform.rotation[1] = Math.PI / 2;
    b.transform = placeMaterial(project, a.instanceId, b.instanceId);
    const c = compileDeclarativeScene(project, a.instanceId, b.instanceId),
      p = await createJoltBackend(c.physics);
    try {
      const initial = p.readMaterial().position;
      p.setSurfaceSpeed(0.4);
      for (let i = 0; i < 90; i++) p.step(1 / 60);
      expect(p.readMaterial().position[2]).toBeLessThan(initial[2] - 0.3);
      expect(p.readMaterial().position[0]).toBeCloseTo(initial[0], 2);
    } finally {
      p.dispose();
    }
  });
  it("rejects unsupported motion, shape, missing body refs and out-of-belt placement", () => {
    const { project, a, b, material } = setup(5);
    const raw = JSON.parse(JSON.stringify(material.source));
    raw.type_specific_contract.physics.bodies[0].motion_type = "kinematic";
    const d = normalizeDeviceSpec(raw);
    expect(() => compileRigidBody(d, b)).toThrow("运动学");
    raw.type_specific_contract.physics.bodies[0].collider.kind = "mesh";
    expect(() => normalizeDeviceSpec(raw)).toThrow();
    const beltRaw = JSON.parse(JSON.stringify(project.definitions[0].source));
    beltRaw.type_specific_contract.conveying_surface.body_ref = "missing";
    expect(() => normalizeDeviceSpec(beltRaw)).toThrow();
    b.transform.position[2] = 2;
    expect(() =>
      compileDeclarativeScene(project, a.instanceId, b.instanceId),
    ).toThrow("超出");
  });
});

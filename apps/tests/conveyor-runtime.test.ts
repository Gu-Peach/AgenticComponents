import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeDeviceSpec } from "../src/domain/normalizeDeviceSpec";
import { instantiate } from "../src/domain/catalog";
import { compileConveyor } from "../src/domain/runtime/compileConveyor";
import { createJoltBackend } from "../src/runtime/physics/jolt/JoltPhysicsBackend";
import { RuntimeKernel } from "../src/runtime/engine/RuntimeKernel";
import { SimulationSession } from "../src/runtime/engine/SimulationSession";
import { SignalRegistry } from "../src/runtime/engine/SignalRegistry";
import { registerTemplates } from "../src/runtime/templates/registerTemplates";
const def = normalizeDeviceSpec(
  JSON.parse(readFileSync("tests/fixtures/conveyor-v1.2.json", "utf8")),
);
function config() {
  const i = instantiate(def, 0);
  i.transform.position = [0, 0, 0];
  return compileConveyor(def, i, 0);
}
describe("contact transport runtime", () => {
  it("transports through contact and observes the requested subject at exit", async () => {
    const c = config(),
      physics = await createJoltBackend(c.physics),
      kernel = new RuntimeKernel(c, physics),
      session = new SimulationSession(kernel);
    const before = JSON.stringify(c);
    try {
      kernel.tasks.submit("r1", c.subjectId);
      kernel.signals.command("runTag", true);
      session.start();
      for (let i = 0; i < 240; i++) session.step(1 / 60);
      const s = session.snapshot();
      expect(s.request?.status).toBe("succeeded");
      expect(s.pose!.position[0]).toBeGreaterThan(0.44);
      expect(s.pose!.position[0]).toBeLessThan(0.65);
      expect(Number(s.signals.actual_speed.value)).toBe(0);
      expect(s.supported).toBe(true);
      expect(JSON.stringify(c)).toBe(before);
      session.pause();
      const paused = session.snapshot();
      for (let i = 0; i < 60; i++) session.step(1 / 60);
      expect(session.snapshot()).toEqual(paused);
    } finally {
      session.stop();
      session.stop();
    }
  });
  it("does not drive an airborne or adjacent cargo", async () => {
    const c = config();
    c.physics.materialPosition = [-0.5, 0.78, 1];
    const p = await createJoltBackend(c.physics);
    try {
      p.setSurfaceSpeed(0.4);
      for (let i = 0; i < 120; i++) p.step(1 / 60);
      expect(p.readMaterial().position[0]).toBeCloseTo(-0.5, 3);
      expect(p.hasSupport()).toBe(false);
    } finally {
      p.dispose();
    }
  });
  it("respects an actual obstacle instead of moving cargo through it", async () => {
    const c = config();
    c.physics.obstacle = true;
    const p = await createJoltBackend(c.physics);
    try {
      p.setSurfaceSpeed(0.4);
      for (let i = 0; i < 240; i++) p.step(1 / 60);
      expect(p.readMaterial().position[0]).toBeLessThan(0.1);
    } finally {
      p.dispose();
    }
  });
  it("keeps a stopped belt still and isolates two worlds", async () => {
    const c = config(),
      a = await createJoltBackend(c.physics),
      b = await createJoltBackend(c.physics);
    try {
      a.setSurfaceSpeed(0.4);
      for (let i = 0; i < 90; i++) {
        a.step(1 / 60);
        b.step(1 / 60);
      }
      expect(a.readMaterial().position[0]).toBeGreaterThan(-0.1);
      expect(b.readMaterial().position[0]).toBeCloseTo(-0.5, 2);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
  it("rejects invalid inputs, unsupported templates and foreign subjects", async () => {
    const signals = new SignalRegistry();
    expect(() => signals.read("actual_speed")).toThrow();
    expect(() => signals.command("speedTag", -1)).toThrow();
    expect(() => signals.command("runTag", 1)).toThrow();
    expect(() => signals.command("done", true)).toThrow();
    expect(() => registerTemplates().get("robot.articulated")).toThrow();
    const c = config(),
      p = await createJoltBackend(c.physics),
      k = new RuntimeKernel(c, p);
    try {
      expect(() => k.tasks.submit("r", "another")).toThrow();
      k.tasks.submit("r", c.subjectId);
      expect(() => k.tasks.submit("r", c.subjectId)).toThrow();
      expect(() => k.step(0.2)).toThrow();
      expect(k.stop().request?.status).toBe("cancelled");
    } finally {
      p.dispose();
    }
  });
  it("rejects non-horizontal scenes rather than reusing a flat collision model", () => {
    const i = instantiate(def, 0);
    i.transform.rotation[0] = 0.2;
    expect(() => compileConveyor(def, i, 0)).toThrow("水平");
  });
});

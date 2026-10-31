import { describe, it, expect } from "vitest";
import { robotSetup } from "./robot-helpers";
import { RuntimeKernel } from "../src/runtime/engine/RuntimeKernel";
import { SimulationSession } from "../src/runtime/engine/SimulationSession";
import { SignalRegistry } from "../src/runtime/engine/SignalRegistry";
const command = (id = 1) => ({
  requestId: id,
  instanceId: "robot",
  behaviorId: "move_joints" as const,
  steps: [{ kind: "move_joints" as const, q: [0.6, 0.1, 0, 0, 0, 0] }],
});
describe("robot runtime", () => {
  it("executes, pauses and restores without author mutations; rejects all reused IDs", () => {
    const { scene, project } = robotSetup(),
      before = JSON.stringify(project),
      kernel = new RuntimeKernel(scene),
      session = new SimulationSession(kernel);
    kernel.submitAction(command());
    session.start();
    for (let i = 0; i < 15; i++) session.step(1 / 60);
    session.pause();
    const paused = session.snapshot();
    for (let i = 0; i < 10; i++) session.step(1 / 60);
    expect(session.snapshot()).toEqual(paused);
    session.resume();
    for (let i = 0; i < 300; i++) session.step(1 / 60);
    expect(session.snapshot().request?.status).toBe("succeeded");
    expect(session.snapshot().robot!.q[0]).toBeCloseTo(0.6);
    kernel.submitAction(command(2));
    for (let i = 0; i < 300; i++) session.step(1 / 60);
    expect(() => kernel.submitAction(command(1))).toThrow("重复");
    session.stop();
    session.stop();
    expect(JSON.stringify(project)).toBe(before);
  });
  it("decelerates on disable and resumes the original step within acceleration limits", () => {
    const { scene } = robotSetup(),
      k = new RuntimeKernel(scene);
    k.submitAction(command());
    for (let i = 0; i < 30; i++) k.step(1 / 60);
    k.command("enableTag", false);
    let prev = k.snapshot().robot!.qdot;
    for (let i = 0; i < 100; i++) {
      const s = k.step(1 / 60);
      s.robot!.qdot.forEach((v, j) =>
        expect(Math.abs(v - prev[j]) * 60).toBeLessThanOrEqual(
          scene.acceleration[j] + 1e-6,
        ),
      );
      prev = s.robot!.qdot;
    }
    expect(k.snapshot().robot!.phase).toBe("holding");
    expect(k.snapshot().request?.status).toBe("busy");
    k.command("enableTag", true);
    for (let i = 0; i < 300; i++) k.step(1 / 60);
    expect(k.snapshot().request?.status).toBe("succeeded");
    k.stop();
  });
  it("unknown signals block waits and simulation-time timeout fails the right request", () => {
    const { scene } = robotSetup(),
      k = new RuntimeKernel(scene);
    k.submitAction({
      requestId: 12,
      instanceId: "robot",
      behaviorId: "execute_job",
      steps: [
        { kind: "wait_signal", portId: "in1Tag", value: true, timeout: 0.1 },
      ],
    });
    for (let i = 0; i < 10; i++) k.step(1 / 60);
    expect(k.snapshot().request?.status).toBe("failed");
    expect(k.snapshot().signals.result_id.value).toBe(12);
    expect(k.snapshot().signals.error.value).toBe(true);
    k.stop();
  });
  it("runs Wait/Set sequences and isolates controllers with equal request ids", () => {
    const { scene } = robotSetup(),
      a = new RuntimeKernel(scene),
      b = new RuntimeKernel(structuredClone(scene));
    a.submitAction({
      requestId: 3,
      instanceId: "robot",
      behaviorId: "execute_job",
      steps: [
        { kind: "wait_signal", portId: "in1Tag", value: true, timeout: 1 },
        { kind: "set_output", portId: "out1Tag", value: true },
        { kind: "wait_time", seconds: 0.03 },
      ],
    });
    b.submitAction(command(3));
    a.command("in1Tag", true);
    for (let i = 0; i < 10; i++) {
      a.step(1 / 60);
      b.step(1 / 60);
    }
    expect(a.snapshot().request?.status).toBe("succeeded");
    expect(a.snapshot().signals.out1Tag.value).toBe(true);
    expect(b.snapshot().request?.status).toBe("busy");
    expect(() =>
      a.submitAction({ ...command(4), instanceId: "foreign" }),
    ).toThrow();
    a.stop();
    b.stop();
  });
  it("validates registered signal directions, integer widths and unknown observations", () => {
    const s = new SignalRegistry([
      { id: "id", direction: "input", type: "DINT" },
      { id: "out", direction: "output", type: "INT" },
    ]);
    expect(() => s.command("id", 2147483648)).toThrow();
    expect(() => s.command("id", 0.2)).toThrow();
    expect(() => s.command("out", true)).toThrow();
    expect(() => s.publish("out", 32768, 0)).toThrow();
    expect(() => s.read("out")).toThrow();
  });
});

it("blocks task admission on pending disable and pending intake pause", () => {
  const { scene } = robotSetup(),
    k = new RuntimeKernel(scene);
  k.command("enableTag", false);
  expect(() => k.submitAction(command())).toThrow("使能");
  k.command("enableTag", true);
  k.command("pause_pick", true);
  expect(() =>
    k.submitAction({
      ...command(),
      behaviorId: "execute_job",
      steps: [{ kind: "grip", materialId: "block" }],
    }),
  ).toThrow("暂停");
  k.stop();
});

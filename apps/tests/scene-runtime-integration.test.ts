import { describe, it, expect, vi } from "vitest";
import { bindProcess } from "../src/domain/runtime/bindProcess";
import {
  ConditionProviders,
  SignalRegistry,
  signalEquals,
  ObservationRegistry,
} from "../src/runtime/signals";
import { SceneRuntimeProgram } from "../src/runtime/engine/SceneRuntimeProgram";
import { SceneRuntimeController } from "../src/services/SceneRuntimeController";
import { sceneSignalDisplay } from "../src/domain/runtime/sceneSignalDisplay";
import type { DeviceActionPort } from "../src/runtime/adapters/scene/DeviceActionPort";
import type { ActionRequest, ActionFeedback } from "../src/contracts/scheduler";
import type { SignalWrite } from "../src/contracts/scene-signals";

/** Deterministic physical-port test double, not a calibrated scene or Jolt experiment. */
function fixture(root?: unknown) {
  let position = 0,
    velocity = 0,
    steps = 0,
    submits = 0,
    active: ActionRequest | undefined;
  const events: ActionFeedback[] = [];
  let signals: SignalWrite[] = [];
  const registry = new SignalRegistry("run", [
    {
      key: "S/R1/execute",
      direction: "input",
      type: "BOOL",
      writer: "process",
    },
    {
      key: "S/R1/request_id",
      direction: "input",
      type: "DINT",
      writer: "process",
    },
    {
      key: "S/R1/ready",
      direction: "output",
      type: "BOOL",
      writer: "adapter:R1",
      maxAgeTicks: 1,
    },
    {
      key: "S/R1/position",
      direction: "output",
      type: "REAL",
      writer: "adapter:R1",
      maxAgeTicks: 1,
    },
    {
      key: "S/R1/done",
      direction: "output",
      type: "BOOL",
      writer: "adapter:R1",
    },
  ]);
  const world = {
    step: () => {
      steps++;
      position += velocity;
    },
    dispose: vi.fn(),
  };
  const stop = () => {
    velocity = 0;
    if (active) events.push({ ...active, status: "stopped" });
  };
  const driver: DeviceActionPort = {
    id: "R1",
    supports: (b) => b === "move",
    prepare: (r) => [
      { key: "S/R1/execute", value: true, writer: "process", ...r },
      {
        key: "S/R1/request_id",
        value: Number(r.requestId),
        writer: "process",
        ...r,
      },
    ],
    prepareCancel: (r) => [
      { key: "S/R1/execute", value: false, writer: "process", ...r },
    ],
    prepareStop: () => [
      { key: "S/R1/execute", value: false, writer: "process", runId: "run" },
    ],
    submit: (r) => {
      submits++;
      active = r;
      velocity = 1;
      events.push({ ...r, status: "accepted" });
    },
    cancel: stop,
    beforePhysics: () => {},
    afterPhysics: () => {
      if (active && position >= 2) {
        velocity = 0;
        events.push({ ...active, status: "succeeded" });
      }
      signals = [
        ["ready", true],
        ["position", position],
        ["done", !!active && position >= 2],
      ].map(([key, value]) => ({
        runId: "run",
        key: `S/R1/${key}`,
        value: value as number | boolean,
        writer: "adapter:R1",
        requestId: active?.requestId,
        activationId: active?.activationId,
      }));
    },
    requestStop: stop,
    isStopped: () => velocity === 0,
    dispose: vi.fn(),
    drainFeedback: () => events.splice(0),
    drainSignals: () => signals.splice(0),
  };
  const conditions = new ConditionProviders();
  conditions.register("ready", signalEquals("S/R1/ready", true));
  conditions.register("physical_complete", {
    evaluate: (c) => {
      const s = c.frame.samples["S/R1/position"];
      return s?.quality === "good" ? Number(s.value) >= 2 : undefined;
    },
  });
  conditions.register("stopped", { evaluate: () => velocity === 0 });
  conditions.register("goal", {
    dependencies: ["physical_complete", "stopped"],
    evaluate: (_c, d) => d.physical_complete === true && d.stopped === true,
  });
  const process = bindProcess(
    root ?? {
      id: "move",
      kind: "invoke",
      device: { kind: "ref", name: "R1" },
      behavior: "move",
      arguments: {},
    },
    {
      scope: { R1: "R1" },
      providers: conditions,
      actions: [
        {
          device: "R1",
          behavior: "move",
          preconditions: ["ready"],
          authorization: [],
          sustaining: ["ready"],
          completion: ["physical_complete"],
          release: [],
          stopped: ["stopped"],
          resources: () => [],
          validateArguments: () => {},
        },
      ],
      finalization: ["goal"],
    },
  );
  return {
    program: new SceneRuntimeProgram("S", "run", process, registry, world, [
      driver,
    ]),
    world,
    driver,
    registry,
    metrics: () => ({ position, steps, submits }),
  };
}
describe("scene scheduling and signal loop", () => {
  it("withdraws same-tick submissions when a sibling fails before dispatch", () => {
    const f = fixture({
      kind: "par",
      id: "parallel",
      join: "all",
      children: [
        {
          id: "move",
          kind: "invoke",
          device: { kind: "ref", name: "R1" },
          behavior: "move",
          arguments: {},
        },
        { id: "fault", kind: "fail", code: "STOP_NOW" },
      ],
    });
    f.program.start();
    for (let i = 0; i < 6 && f.program.snapshot().status === "running"; i++)
      f.program.step(1 / 60);
    expect(f.program.snapshot().status).toBe("failed");
    expect(f.metrics().submits).toBe(0);
    expect(f.metrics().position).toBe(0);
  });
  it("observes before admission, submits once, steps once, and finishes on observed feedback", () => {
    const f = fixture();
    expect(f.program.snapshot().signals.samples["S/R1/done"].quality).toBe(
      "unknown",
    );
    f.program.start();
    f.program.step(1 / 60);
    expect(f.metrics().submits).toBe(0);
    for (let i = 0; i < 10 && f.program.snapshot().status === "running"; i++)
      f.program.step(1 / 60);
    expect(f.program.snapshot().status).toBe("succeeded");
    expect(f.metrics().submits).toBe(1);
    expect(f.metrics().steps).toBe(f.program.snapshot().tick);
    expect(f.metrics().position).toBe(2);
    expect(
      sceneSignalDisplay(f.program.snapshot(), "S", "R1", "done").text,
    ).toBe("true");
    expect(
      sceneSignalDisplay(f.program.snapshot(), "other", "R1", "done").quality,
    ).toBe("unknown");
    f.program.dispose();
    expect(f.world.dispose).toHaveBeenCalledOnce();
  });
  it("freezes during pause and drains cancellation feedback before final stop", () => {
    const f = fixture();
    f.program.start();
    f.program.step(1 / 60);
    f.program.step(1 / 60);
    f.program.pause();
    const old = f.metrics();
    f.program.step(1 / 60);
    expect(f.metrics()).toEqual(old);
    f.program.stop();
    f.program.step(1 / 60);
    expect(f.program.snapshot().status).toBe("cancelled");
    expect(f.program.snapshot().process.resources).toEqual({});
  });
  it("publishes immutable read-only controller snapshots and cleans up on detach", () => {
    const f = fixture(),
      controller = new SceneRuntimeController();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.attach(f.program);
    controller.start("S");
    const initial = controller.snapshot("S")!;
    controller.step("S", 1 / 60);
    const visual = controller.visualFrame("S")!;
    expect(visual.previous.tick).toBe(0);
    expect(visual.current.tick).toBe(1);
    expect(controller.snapshot("S")).toBe(initial);
    controller.pause("S");
    expect(controller.visualFrame("S")?.previous).toBe(
      controller.visualFrame("S")?.current,
    );
    controller.resume("S");
    for (
      let i = 0;
      i < 8 && controller.snapshot("S")?.status !== "succeeded";
      i++
    )
      controller.step("S", 1 / 60);
    expect(controller.snapshot("S")?.status).toBe("succeeded");
    expect(listener).toHaveBeenCalled();
    controller.detach("S");
    expect(controller.snapshot("S")).toBeUndefined();
    expect(controller.visualFrame("S")).toBeUndefined();
  });
  it("keeps observations separate, immutable and freshness checked", () => {
    const observations = new ObservationRegistry("run", [
      {
        key: "support",
        provider: "physics",
        maxAgeTicks: 1,
        validate: (v) => Array.isArray(v),
      },
    ]);
    const value = ["body1"];
    observations.publish(
      [{ runId: "run", key: "support", provider: "physics", value }],
      1,
    );
    value.push("body2");
    expect(observations.snapshot().samples.support.value).toEqual(["body1"]);
    expect(observations.snapshot(3).samples.support.quality).toBe("stale");
    expect(() =>
      observations.publish(
        [{ runId: "old", key: "support", provider: "physics", value: [] }],
        3,
      ),
    ).toThrow();
  });
});

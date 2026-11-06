import { describe, it, expect } from "vitest";
import { createJoltBackend } from "../src/runtime/physics/jolt/JoltPhysicsBackend";
import { PositionTransportAdapter } from "../src/runtime/adapters/scene/PositionTransportAdapter";
import { mergeCoupledConveyors } from "../src/domain/runtime/mergeCoupledConveyors";
import {
  FiniteSceneEnvironment,
  type CarrierLoad,
} from "../src/runtime/services/FiniteSceneEnvironment";
import type {
  PhysicsConfig,
  RuntimeBody,
  BodyPose,
} from "../src/contracts/physics";
import type { ActionRequest } from "../src/contracts/scheduler";
import { readFileSync } from "node:fs";
import { bindPositionTransport } from "../src/domain/runtime/bindPositionTransport";
import { bindProcess } from "../src/domain/runtime/bindProcess";
import { signalLayoutFromContract } from "../src/domain/runtime/bindDeviceBehavior";
import {
  ConditionProviders,
  SignalRegistry,
  ObservationRegistry,
} from "../src/runtime/signals";
import { SceneRuntimeProgram } from "../src/runtime/engine/SceneRuntimeProgram";

function config(): PhysicsConfig {
  const body = (
    id: string,
    x: number,
    y: number,
    size: [number, number, number],
    role: RuntimeBody["role"],
    dynamic = false,
    active = true,
  ): RuntimeBody => ({
    id,
    instanceId: id,
    position: [x, y, 0],
    rotation: [0, 0, 0, 1],
    size,
    role,
    motionType: dynamic ? "dynamic" : "static",
    mass: dynamic ? 1 : undefined,
    friction: 0.8,
    restitution: 0,
    initiallyActive: active,
  });
  return {
    surfacePosition: [0, 0, 0],
    surfaceSize: [2, 0.1, 1],
    rotation: [0, 0, 0, 1],
    materialPosition: [-0.7, 0.05, 0],
    materialSize: [0.3, 0.1, 0.3],
    mass: 1,
    friction: 0.8,
    targetBodyId: "P1",
    bodies: [
      body("L", -0.5, -0.05, [1, 0.1, 1], "conveying_support"),
      body("R", 0.5, -0.05, [1, 0.1, 1], "conveying_support"),
      body("P1", -0.7, 0.051, [0.3, 0.1, 0.3], "carrier", true),
      body("M1", -0.7, 0.152, [0.1, 0.1, 0.1], "material", true),
      body("P2", -0.7, 0.051, [0.3, 0.1, 0.3], "carrier", true, false),
      body("M2", -0.7, 0.152, [0.1, 0.1, 0.1], "material", true, false),
    ],
    surfaces: [
      { id: "left", bodyId: "L", direction: [1, 0, 0], normal: [0, 1, 0] },
      { id: "right", bodyId: "R", direction: [1, 0, 0], normal: [0, 1, 0] },
    ],
  };
}
const request: ActionRequest = {
  runId: "run",
  activationId: "move1",
  requestId: "1",
  device: "C2",
  behavior: "transport_to_position",
  subjectId: "1",
  arguments: { subject_id: 1, target: "scene.sorting" },
};
describe("position transport with real Jolt contact physics", () => {
  it("closes scheduler, command acknowledgement, Jolt position feedback and independent goal in one world", async () => {
    const p = await createJoltBackend(
      mergeCoupledConveyors(config(), ["left", "right"], "mainline"),
    );
    const contract = JSON.parse(
      readFileSync("public/scene/S01/contracts/conveyor.json", "utf8"),
    );
    const profile = {
      sceneId: "S",
      runId: "run",
      leader: "C2",
      drives: [
        {
          device: "C1",
          surfaceId: "left",
          flow: [1, 0, 0] as [number, number, number],
        },
        {
          device: "C2",
          surfaceId: "right",
          flow: [1, 0, 0] as [number, number, number],
        },
      ],
      subjects: new Map([
        [
          1,
          {
            id: "P1",
            bodyId: "P1",
            referenceOffset: [0, -0.05, 0] as [number, number, number],
          },
        ],
      ]),
      targets: [
        {
          id: "scene.sorting",
          index: 1,
          position: [0.5, 0, 0] as [number, number, number],
          supportIds: ["right"],
        },
      ],
      maxSpeed: 0.25,
      acceleration: 0.5,
      deceleration: 0.5,
      positionTolerance: 0.03,
      speedTolerance: 0.02,
      verticalTolerance: 0.04,
      settleTicks: 3,
    };
    const providers = new ConditionProviders();
    providers.register("fixture_clear", { evaluate: () => true });
    providers.register("goal", {
      evaluate(c) {
        const sample = c.observations?.samples["C2/transport"];
        if (sample?.quality !== "good") return undefined;
        const v = sample.value as {
          position: number[];
          supported: boolean;
          stationary: boolean;
        };
        return (
          Math.abs(v.position[0] - 0.5) < 0.03 && v.supported && v.stationary
        );
      },
    });
    const bound = bindPositionTransport(
      profile,
      contract,
      providers,
      "fixture_clear",
    );
    const program = bindProcess(
      {
        id: "move",
        kind: "invoke",
        device: { kind: "ref", name: "C2" },
        behavior: "transport_to_position",
        arguments: {
          subject_id: { kind: "literal", value: 1 },
          target: { kind: "literal", value: "scene.sorting" },
        },
      },
      {
        scope: { C2: "C2" },
        actions: [bound.binding],
        providers,
        finalization: ["goal"],
      },
    );
    const signals = new SignalRegistry("run", [
      ...signalLayoutFromContract("S", "C1", contract),
      ...signalLayoutFromContract("S", "C2", contract),
    ]);
    const session = new SceneRuntimeProgram(
      "S",
      "run",
      program,
      signals,
      p,
      [new PositionTransportAdapter(profile, p)],
      new ObservationRegistry("run", bound.observations),
    );
    try {
      session.start();
      for (let i = 0; i < 1800 && session.snapshot().status === "running"; i++)
        session.step(1 / 60);
      expect(session.snapshot().status, session.snapshot().error).toBe(
        "succeeded",
      );
      expect(signals.snapshot().samples["S/C2/done"].value).toBe(true);
      expect(signals.snapshot().samples["S/C2/execute"].value).toBe(false);
      expect(signals.snapshot().samples["S/C2/accepted"].value).toBe(false);
      expect(
        signals
          .trace()
          .events.filter((e) => e.key === "S/C2/execute")
          .map((e) => e.sample.value),
      ).toEqual([true, false]);
    } finally {
      p.dispose();
    }
  });
  it("independently addresses surfaces and rejects partial speed batches", async () => {
    const p = await createJoltBackend(config());
    try {
      expect(() => p.setSurfaceSpeed(0.2)).toThrow("explicit");
      p.setSurfaceSpeeds!({ left: 0.2, right: 0 });
      expect(p.getSurfaceSpeed!("right")).toBe(0);
      expect(() => p.setSurfaceSpeeds!({ left: 0.4, missing: 0.3 })).toThrow();
      expect(p.getSurfaceSpeed!("left")).toBe(0.2);
    } finally {
      p.dispose();
    }
  });
  it("moves a loaded carrier across two real surfaces and stops at the reference point", async () => {
    const p = await createJoltBackend(
      mergeCoupledConveyors(config(), ["left", "right"], "mainline"),
    );
    const d = new PositionTransportAdapter(
      {
        sceneId: "S",
        runId: "run",
        leader: "C2",
        drives: [
          { device: "C1", surfaceId: "left", flow: [1, 0, 0] },
          { device: "C2", surfaceId: "right", flow: [1, 0, 0] },
        ],
        subjects: new Map([
          [1, { id: "P1", bodyId: "P1", referenceOffset: [0, -0.05, 0] }],
        ]),
        targets: [
          {
            id: "scene.sorting",
            index: 1,
            position: [0.5, 0, 0],
            supportIds: ["right"],
          },
        ],
        maxSpeed: 0.25,
        acceleration: 0.5,
        deceleration: 0.5,
        positionTolerance: 0.03,
        speedTolerance: 0.02,
        verticalTolerance: 0.04,
        settleTicks: 3,
      },
      p,
    );
    try {
      for (let i = 0; i < 90; i++) p.step(1 / 60);
      expect(p.hasSupport("M1", "P1")).toBe(true);
      d.prepare(request, { runId: "run", tick: 0, revision: 0, samples: {} });
      d.submit(request);
      let completed = false;
      for (let tick = 1; tick <= 1800; tick++) {
        d.beforePhysics(1 / 60);
        expect(p.getSurfaceSpeed!("left")).toBe(p.getSurfaceSpeed!("right"));
        p.step(1 / 60);
        d.afterPhysics(1 / 60, tick);
        if (d.drainFeedback().some((f) => f.status === "succeeded")) {
          completed = true;
          break;
        }
      }
      expect(
        completed,
        JSON.stringify({
          pose: p.readBody!("P1"),
          speed: p.getSurfaceSpeed!("left"),
          observation: d.drainObservations().at(-1),
        }),
      ).toBe(true);
      expect(p.readBody!("P1").position[0]).toBeCloseTo(0.5, 1);
      expect(d.isStopped()).toBe(true);
      expect(p.hasSupport("P1", "right")).toBe(true);
      expect(p.hasSupport("M1", "P1")).toBe(true);
    } finally {
      p.dispose();
    }
  });
  it("admits finite dormant loads and never removes an unconfirmed or nonempty carrier", async () => {
    const c = config(),
      p = await createJoltBackend(c);
    const loads: CarrierLoad[] = [1, 2].map((n) => {
      const def = (id: string) => {
        const b = c.bodies!.find((b) => b.id === id)!;
        return {
          id,
          bodyId: id,
          size: b.size,
          initial: {
            position: b.position,
            rotation: b.rotation,
            velocity: [0, 0, 0],
          } as BodyPose,
        };
      };
      return {
        carrier: def("P" + n),
        items: [def("M" + n)],
        sourceSupport: "left",
      };
    });
    const service = new FiniteSceneEnvironment("run", p, loads);
    const target = {
      position: [-0.7, 0.05, 0] as [number, number, number],
      referenceOffset: [0, 0, 0] as [number, number, number],
      supportId: "left",
      tolerance: 0.03,
      speedTolerance: 0.05,
    };
    try {
      expect(p.isBodyActive!("P2")).toBe(false);
      service.admit("P1", 0);
      for (let i = 0; i < 120; i++) p.step(1 / 60);
      expect(service.observeSupply("P1", 120)).toBe(true);
      expect(service.takeCarrier("P1", target, 121)).toBe(false);
      expect(() => service.admit("P2", 122)).toThrow("Previous");
      expect(
        service.deliverMaterial(
          "M1",
          { ...target, position: [0.5, 0.15, 0], supportId: "P1" },
          123,
        ),
      ).toBe(false);
      expect(
        service.deliverMaterial(
          "M1",
          { ...target, position: [-0.7, 0.15, 0], supportId: "P1" },
          124,
        ),
      ).toBe(true);
      expect(service.takeCarrier("P1", target, 125)).toBe(true);
      expect(p.isBodyActive!("P1")).toBe(false);
      service.admit("P2", 126);
      expect(p.isBodyActive!("P2")).toBe(true);
      expect(service.observeSupply("P2", 126)).toBe(false);
      for (let i = 0; i < 120; i++) p.step(1 / 60);
      expect(service.observeSupply("P2", 246)).toBe(true);
      expect(service.complete()).toBe(false);
      expect(
        service.snapshot().filter((r) => r.kind === "material_delivered"),
      ).toHaveLength(1);
    } finally {
      p.dispose();
    }
  });
});

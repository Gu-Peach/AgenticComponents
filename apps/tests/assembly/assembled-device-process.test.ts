import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  compileTransferWorkcell,
  transferProcess,
} from "@/domain/runtime/compileTransferWorkcell";
import {
  assembleTransferWorkcell,
  type CellReading,
} from "@/runtime/assembly/TransferWorkcell";
import { instantiate } from "@/domain/catalog";
import { normalizeDeviceSpec } from "@/domain/normalizeDeviceSpec";
import { RobotKinematics } from "@/runtime/kinematics/RobotKinematics";
import { robotSetup } from "../robot-helpers";

function fixture() {
  const { project, instance, scene } = robotSetup();
  instance.instanceId = "robot-f103";
  const load = (folder: string) =>
    normalizeDeviceSpec(
      JSON.parse(
        readFileSync("public/modles/" + folder + "/schema.json", "utf8"),
      ),
    );
  const beltDef = load("Conveyor_aankws"),
    loadDef = load("engine_block");
  const belt = instantiate(beltDef, 1),
    material = instantiate(loadDef, 2);
  belt.instanceId = "infeed-17";
  material.instanceId = "casting-01";
  const tcp = new RobotKinematics(scene).forward([0, 0, 0, 0, 0, 0]).tcp
    .position;
  belt.transform.position = [tcp[0] - 0.26, 0, tcp[2]];
  material.transform.position = [
    belt.transform.position[0] - 0.15,
    0.7,
    tcp[2],
  ];
  material.transform.rotation = [0, Math.PI / 2, 0];
  material.paramOverrides.mass_kg = 1;
  project.definitions.push(beltDef, loadDef);
  project.instances.push(belt, material);
  return {
    project,
    selection: {
      conveyor: belt.instanceId,
      robot: instance.instanceId,
      material: material.instanceId,
      support: belt.instanceId,
    },
  };
}
it("runs the compiled transport and pick/place process across separately added model instances", async () => {
  const { project, selection } = fixture(),
    before = JSON.stringify(project);
  const c = compileTransferWorkcell(project, selection);
  expect(c.connections.map((e) => e.semantic)).toEqual(["at", "supported_at"]);
  const run = await assembleTransferWorkcell(c, "composed", "first");
  run.start();
  let s = run.snapshot(),
    wasHeld = false;
  let firstFailure: unknown;
  let lastPhase = "";
  for (let i = 0; i < 10000 && run.needsStep(); i++) {
    s = run.step(1 / 60);
    const w = s.observations.samples["cell/state"].value as CellReading;
    wasHeld ||= w.held;
    const robot = s.observations.samples[selection.robot + "/robot_state"]
      ?.value as
      | {
          phase: string;
          tcp: { position: number[] };
          placementConfirmed: boolean;
          motionIntegrity: boolean;
        }
      | undefined;
    if (
      !firstFailure &&
      (s.error ||
        ["stopping", "attention_required", "failed"].includes(s.status))
    )
      firstFailure = {
        tick: s.tick,
        error: s.error,
        status: s.status,
        arm: robot?.phase,
        center: w.pose.position,
        target: c.robot.placementCenter,
        activations: s.process.activations
          .slice(-2)
          .map((a) => [a.state, a.node]),
      };
    if (!firstFailure && robot) lastPhase = robot.phase;
  }
  expect(
    s.status,
    JSON.stringify({
      firstFailure,
      previousPhase: lastPhase,
      lastTick: s.tick,
    }),
  ).toBe("succeeded");
  expect(wasHeld).toBe(true);
  expect(
    (s.observations.samples["cell/state"].value as CellReading).targetSupported,
  ).toBe(true);
  expect(s.process.resources).toEqual({});
  expect(JSON.stringify(project)).toBe(before);
  run.dispose();
}, 60000);
it("diagnoses an unwired source before starting the physics world", () => {
  const { project, selection } = fixture();
  const ir = transferProcess();
  if (
    ir.kind !== "seq" ||
    ir.children[1].kind !== "invoke" ||
    ir.children[1].payload?.kind !== "payload"
  )
    throw new Error("missing pickup");
  ir.children[1].payload.kwargs.source = {
    kind: "literal",
    value: "other.exit",
  };
  expect(() => compileTransferWorkcell(project, selection, ir)).toThrow(
    /生产者/,
  );
});

it("binds repeated control activations to the producer from the same iteration", async () => {
  const { project, selection } = fixture();
  const root = {
    kind: "repeat",
    id: "twice",
    count: { kind: "literal", value: 2 },
    body: transferProcess(),
  };
  const c = compileTransferWorkcell(project, selection, root);
  const run = await assembleTransferWorkcell(c, "repeat-cell", "repeat-run");
  run.start();
  for (let n = 0; n < 15000 && run.needsStep(); n++) run.advance(1 / 60);
  const snapshot = run.snapshot();
  expect(snapshot.status, snapshot.error).toBe("succeeded");
  const placements = snapshot.process.activations.filter(
    (a) => a.node === "place",
  );
  expect(placements).toHaveLength(2);
  const sources = placements.map((a) =>
    run.scheduler.successfulPredecessor(a.id, "arrive"),
  );
  expect(sources.every(Boolean)).toBe(true);
  expect(sources[0]!.requestId).not.toBe(sources[1]!.requestId);
  const receipts = (
    snapshot.observations.samples["cell/state"].value as CellReading
  ).receipts;
  for (const r of sources)
    expect(
      receipts.some(
        (f) =>
          f.requestId === r!.requestId && f.activationId === r!.activationId,
      ),
    ).toBe(true);
  run.dispose();
}, 60000);

import { readFileSync } from "node:fs";
import { Vector3 } from "three";
import { expect, it, vi } from "vitest";
import {
  importScenePackage,
  fetchSceneCatalog,
} from "../../src/services/PublicSceneCatalog";
import { prepareScenePackage } from "../../src/services/prepareScenePackage";
import { projectRepository } from "../../src/services/BrowserProjectRepository";
import { useWorkspace } from "../../src/stores/workspace";
import type { IndexingCellMotion } from "../../src/runtime/services/IndexingCellMotion";
import type { SceneRuntimeSnapshot } from "../../src/runtime/engine/SceneRuntimeProgram";

async function prepare() {
  const previous = useWorkspace.getState(),
    assets = new Map<string, Blob>();
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(readFileSync("public" + decodeURIComponent(url))),
  );
  vi.spyOn(projectRepository, "putAsset").mockImplementation(
    async (id, data) => {
      assets.set(id, data);
    },
  );
  vi.spyOn(projectRepository, "getAsset").mockImplementation(async (id) =>
    assets.get(id),
  );
  try {
    previous.initialize();
    const entry = (await fetchSceneCatalog()).find((e) => e.id === "S11")!;
    const id = await importScenePackage(entry);
    const instance = useWorkspace
      .getState()
      .project!.scenePackages!.find((s) => s.id === id)!;
    return await prepareScenePackage(
      instance,
      "validation",
      new AbortController().signal,
    );
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useWorkspace.setState(previous, true);
  }
}
function state(s: SceneRuntimeSnapshot) {
  return s.observations.samples["indexing/state"].value as ReturnType<
    IndexingCellMotion["snapshot"]
  > & {
    active: string | null;
    onSource: boolean;
    delivered: { material: string; target: string; tick: number }[];
  };
}

it("imports the S11 cell and completes two positive half turns and a measured tool operation per identity", async () => {
  const { compiled, program } = await prepare(),
    cfg = compiled.indexedProcessing!;
  expect(program.snapshot().status).toBe("ready");
  program.start();
  let s = program.snapshot();
  for (let i = 0; i < 72000 && program.needsStep(); i++)
    s = program.step(1 / 60);
  const w = state(s);
  expect(
    s.status,
    JSON.stringify({
      tick: s.tick,
      error: s.error,
      recent: s.process.activations.slice(-4),
      cell: w,
    }),
  ).toBe("succeeded");
  expect(w.delivered.map((r) => r.material)).toEqual(
    cfg.jobs.map((j) => j.material),
  );
  expect(w.operations.map((r) => r.material)).toEqual(
    cfg.jobs.map((j) => j.material),
  );
  const limits = compiled.devices.get(cfg.robot)!.parameters;
  for (const job of cfg.jobs) {
    const transfers = w.transfers.filter((r) => r.material === job.material),
      turns = w.rotations.filter((r) => r.material === job.material);
    const [op] = w.operations.filter((r) => r.material === job.material);
    expect(transfers.map((r) => [r.source, r.target])).toEqual([
      [job.input, cfg.slot],
      [cfg.slot, job.target],
    ]);
    expect(turns.map((r) => r.toDeg - r.fromDeg)).toEqual([180, 180]);
    const ticks = [
      transfers[0].tick,
      turns[0].tick,
      op.startTick,
      op.endTick,
      turns[1].tick,
      transfers[1].tick,
    ];
    expect(
      ticks.every((tick, index) => index === 0 || tick > ticks[index - 1]),
    ).toBe(true);
    expect(op.dwellTicks).toBeGreaterThanOrEqual(
      Math.ceil(Number(limits.process_time_s) * 60),
    );
    expect(op.maxPositionError).toBeLessThanOrEqual(
      Number(limits.process_position_tolerance_m),
    );
    expect(op.maxAngleErrorDeg).toBeLessThanOrEqual(
      Number(limits.process_angle_tolerance_deg),
    );
  }
  expect(w.humanHome && w.robotHome && !w.holding && !w.tableMaterial).toBe(
    true,
  );
  expect(s.process.resources).toEqual({});
  console.log("S11 completed at tick", s.tick);
  program.dispose();
}, 120000);

it("holds the indexed workpiece on the table if processing is stopped before completion", async () => {
  const { compiled, program } = await prepare(),
    cfg = compiled.indexedProcessing!;
  program.start();
  let s = program.snapshot();
  const busy = () => state(s).phase[cfg.robot] === "process";
  for (let i = 0; i < 12000 && program.needsStep() && !busy(); i++)
    s = program.step(1 / 60);
  expect(busy(), JSON.stringify({ error: s.error, cell: state(s) })).toBe(true);
  program.pause();
  expect(program.step(1 / 60).tick).toBe(s.tick);
  program.resume();
  program.stop();
  for (let i = 0; i < 3000 && program.needsStep(); i++)
    s = program.step(1 / 60);
  expect(s.status, s.error).toBe("cancelled");
  expect(state(s).tableMaterial).toBe(cfg.jobs[0].material);
  expect(state(s).operations).toEqual([]);
  expect(state(s).delivered).toEqual([]);
  expect(s.process.resources).toEqual({});
  program.dispose();
}, 60000);

it("brakes a loaded index between stations and retains the workpiece without a rotation receipt", async () => {
  const { compiled, program } = await prepare(),
    cfg = compiled.indexedProcessing!,
    material = cfg.jobs[0].material;
  program.start();
  let s = program.snapshot();
  for (
    let i = 0;
    i < 4000 && program.needsStep() && state(s).measuredAngleDeg < 45;
    i++
  )
    s = program.step(1 / 60);
  const start = state(s);
  expect(start.phase[cfg.table]).toBe("index");
  expect(start.tableMaterial).toBe(material);
  expect(start.rotations).toHaveLength(0);
  const pose = (sample: SceneRuntimeSnapshot) => {
    const world = sample.observations.samples["world/state"].value as {
      bodies: Record<string, { pose: { position: [number, number, number] } }>;
    };
    return new Vector3(...world.bodies[material + "/body"].pose.position);
  };
  const initialLoad = pose(s);
  program.stop();
  for (let i = 0; i < 3000 && program.needsStep(); i++)
    s = program.step(1 / 60);
  const stopped = state(s);
  expect(s.status, s.error).toBe("cancelled");
  expect(stopped.measuredAngleDeg).toBeGreaterThan(start.measuredAngleDeg);
  expect(stopped.measuredAngleDeg).toBeLessThan(180);
  expect(stopped.stopped[cfg.table]).toBe(true);
  expect(stopped.tableMaterial).toBe(material);
  const pivot = new Vector3(...cfg.pivot);
  const expected = initialLoad
    .sub(pivot)
    .applyAxisAngle(
      new Vector3(...cfg.axis),
      ((stopped.measuredAngleDeg - start.measuredAngleDeg) * Math.PI) / 180,
    )
    .add(pivot);
  expect(pose(s).distanceTo(expected)).toBeLessThan(0.01);
  expect(stopped.active).toBe(material);
  expect(stopped.rotations).toEqual([]);
  expect(stopped.operations).toEqual([]);
  expect(stopped.delivered).toEqual([]);
  expect(s.process.resources).toEqual({});
  program.dispose();
}, 60000);

it("retains a suspended human load on stop and restores the initial batch after explicit discard", async () => {
  const { compiled, program } = await prepare(),
    cfg = compiled.indexedProcessing!,
    material = cfg.jobs[0].material;
  program.start();
  let s = program.snapshot();
  for (
    let i = 0;
    i < 4000 && program.needsStep() && state(s).phase[cfg.human] !== "carry";
    i++
  )
    s = program.step(1 / 60);
  expect(state(s).holding).toBe(material);
  program.stop();
  for (let i = 0; i < 3000 && program.needsStep(); i++)
    s = program.step(1 / 60);
  const stopped = state(s);
  expect(s.status, s.error).toBe("attention_required");
  expect(stopped.holding).toBe(material);
  expect(stopped.active).toBe(material);
  expect(stopped.transfers).toEqual([]);
  expect(stopped.operations).toEqual([]);
  expect(stopped.delivered).toEqual([]);
  program.discard();
  expect(program.snapshot().status).toBe("disposed");
  const reset = (await prepare()).program,
    initial = state(reset.snapshot());
  expect(reset.snapshot().status).toBe("ready");
  expect(initial.active).toBe(material);
  expect(initial.onSource).toBe(true);
  expect(initial.humanHome).toBe(true);
  expect(initial.holding).toBe(null);
  expect(initial.tableMaterial).toBe(null);
  expect(initial.transfers).toEqual([]);
  expect(initial.operations).toEqual([]);
  expect(initial.delivered).toEqual([]);
  reset.dispose();
}, 60000);

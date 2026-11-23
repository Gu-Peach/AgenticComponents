import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";
import { assembleSceneRuntime } from "../../src/runtime/assembly/SceneRuntimeAssembler";
import type { SceneConditionWorld } from "../../src/runtime/assembly/SceneConditionBindings";
import { sceneFixture } from "./fixtures";
import {
  fetchSceneCatalog,
  importScenePackage,
} from "../../src/services/PublicSceneCatalog";
import { prepareScenePackage } from "../../src/services/prepareScenePackage";
import { projectRepository } from "../../src/services/BrowserProjectRepository";
import { useWorkspace } from "../../src/stores/workspace";

function compile() {
  const { bundle, bytes, goal } = sceneFixture("S06");
  return compileSceneRuntime(bundle, bytes, goal, "validation");
}

it("binds the machine table, finished template and distinct original slots to the actual S06 model", () => {
  const c = compile(),
    machining = c.machining!;
  const raw = c.visualBodies.filter((b) => b.finishedVariant);
  expect(raw).toHaveLength(9);
  expect(c.physics.carrierBindings).toHaveLength(9);
  expect(c.bodyMap.get(machining.machine + "/support")?.role).toBe("support");
  expect(new Set(raw.flatMap((b) => b.meshes)).size).toBe(9);
  for (const b of raw) {
    const body = c.bodyMap.get(b.bodyId)!;
    expect(body.position[1] - body.size[1] / 2).toBeCloseTo(
      c.devices.get(machining.pallets[0].id)!.geometry.bounds.max[1],
      6,
    );
    expect(b.finishedVariant!.meshes).toEqual(
      c.devices.get("Finished")!.node_binding.owned_mesh_indices,
    );
    expect(b.meshes.every((i) => !c.hiddenMeshes!.includes(i))).toBe(true);
  }
  expect(c.hiddenMeshes).toEqual(
    expect.arrayContaining(raw[0].finishedVariant!.meshes),
  );
  const { bundle, bytes, goal } = sceneFixture("S06");
  goal.all[0].items[0].slot = goal.all[0].items[1].slot;
  expect(() => compileSceneRuntime(bundle, bytes, goal, "validation")).toThrow(
    /return-slot/,
  );
});

it("machines all nine identities once after retreat and returns each to its original slot before departure", async () => {
  // Keep catalog hashes, import validation, and candidate preparation in the replay.
  const previous = useWorkspace.getState();
  const assets = new Map<string, Blob>();
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(readFileSync("public" + decodeURIComponent(url))),
  );
  vi.spyOn(projectRepository, "putAsset").mockImplementation(
    async (id, blob) => {
      assets.set(id, blob);
    },
  );
  vi.spyOn(projectRepository, "getAsset").mockImplementation(async (id) =>
    assets.get(id),
  );
  let assembled;
  try {
    previous.initialize();
    const entry = (await fetchSceneCatalog()).find((e) => e.id === "S06")!;
    const id = await importScenePackage(entry);
    const scene = useWorkspace
      .getState()
      .project!.scenePackages!.find((s) => s.id === id)!;
    assembled = await prepareScenePackage(
      scene,
      "validation",
      new AbortController().signal,
    );
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useWorkspace.setState(previous, true);
  }
  const { compiled: c, program } = assembled;
  const m = c.machining!,
    pallet = m.pallets[0];
  const returned = new Set<string>();
  try {
    expect(program.snapshot().status).toBe("ready");
    program.start();
    let snapshot = program.snapshot();
    const world = () =>
      snapshot.observations.samples["world/state"].value as SceneConditionWorld;
    let previousCount = 0;
    for (let i = 0; i < 72000 && program.needsStep(); i++) {
      snapshot = program.step(1 / 60);
      const w = world(),
        state = w.machining!;
      if (state.operations.length > previousCount) {
        const item = pallet.items[previousCount],
          last = state.operations.at(-1)!;
        expect(last.material).toBe(item.material);
        expect(state.machineItem).toBe(item.material);
        expect(w.bodies[item.material + "/body"].materialState).toBe(
          "finished",
        );
        expect(w.robotClear[m.robot]).toBe(true);
        previousCount = state.operations.length;
      }
      for (const item of pallet.items) {
        if (
          state.slots[item.source] === item.material &&
          w.bodies[item.material + "/body"].materialState === "finished"
        )
          returned.add(item.material);
      }
    }
    const w = world();
    expect(
      snapshot.status,
      JSON.stringify({
        tick: snapshot.tick,
        error: snapshot.error,
        activations: snapshot.process.activations.slice(-3),
        state: w.machining,
      }),
    ).toBe("succeeded");
    expect(w.machining!.operations.map((op) => op.material)).toEqual(
      pallet.items.map((i) => i.material),
    );
    expect(new Set(w.machining!.operations.map((op) => op.request)).size).toBe(
      9,
    );
    expect([...returned]).toEqual(pallet.items.map((i) => i.material));
    expect(
      w.receipts
        .filter((r) => r.kind === "carrier_departed")
        .map((r) => r.subjectId),
    ).toEqual([pallet.id]);
    expect(snapshot.process.resources).toEqual({});
    console.log("S06 complete at tick", snapshot.tick);
  } finally {
    program.dispose();
  }
}, 120000);

it("stops an active machining cycle with its original raw workpiece still at the work point", async () => {
  const c = compile(),
    m = c.machining!,
    first = m.pallets[0].items[0].material;
  const { program } = await assembleSceneRuntime(
    "s06-stop",
    "machining-stop",
    c,
  );
  try {
    program.start();
    let snapshot = program.snapshot();
    const busy = () =>
      snapshot.signals.samples["s06-stop/" + m.machine + "/busy"]?.value ===
      true;
    for (let i = 0; i < 15000 && program.needsStep() && !busy(); i++)
      snapshot = program.step(1 / 60);
    expect(
      busy(),
      JSON.stringify({
        error: snapshot.error,
        active: snapshot.process.activations.slice(-2),
      }),
    ).toBe(true);
    program.stop();
    for (let i = 0; i < 5000 && program.needsStep(); i++)
      snapshot = program.step(1 / 60);
    const w = snapshot.observations.samples["world/state"]
      .value as SceneConditionWorld;
    expect(snapshot.status, snapshot.error).toBe("cancelled");
    expect(snapshot.process.resources).toEqual({});
    expect(w.machining!.operations).toEqual([]);
    expect(w.bodies[first + "/body"].materialState).toBe("raw");
    expect(w.machining!.machineItem).toBe(first);
  } finally {
    program.dispose();
  }
}, 60000);

it("keeps a suspended part until an explicit discard of the stopped cell", async () => {
  const c = compile();
  const { program } = await assembleSceneRuntime("cell", "held-stop", c);
  const holding = "cell/" + c.machining!.robot + "/holding_material";
  program.start();
  let snapshot = program.snapshot();
  for (let i = 0; i < 6000 && !snapshot.signals.samples[holding]?.value; i++)
    snapshot = program.step(1 / 60);
  expect(snapshot.signals.samples[holding]?.value).toBe(true);
  program.stop();
  for (let i = 0; i < 2400 && program.needsStep(); i++)
    snapshot = program.step(1 / 60);
  expect(snapshot.status).toBe("attention_required");
  expect(snapshot.signals.samples[holding]?.value).toBe(true);
  const world = snapshot.observations.samples["world/state"].value as SceneConditionWorld;
  expect(world.machining!.operations).toEqual([]);
  program.discard();
  expect(program.snapshot().status).toBe("disposed");
});

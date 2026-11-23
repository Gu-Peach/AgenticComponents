import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { sceneBundleSchema } from "../../src/contracts/scene-package";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";
import { assembleSceneRuntime } from "../../src/runtime/assembly/SceneRuntimeAssembler";
import { projectRepository } from "../../src/services/BrowserProjectRepository";
import {
  fetchSceneCatalog,
  importScenePackage,
} from "../../src/services/PublicSceneCatalog";
import { prepareScenePackage } from "../../src/services/prepareScenePackage";
import { useWorkspace } from "../../src/stores/workspace";

const folder = "public/scene/S04";
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

it.each([1, 4])(
  "transfers %i bottle(s) between opposing grasp frames and delivers them inverted in Jolt",
  async (count) => {
    const bundle = sceneBundleSchema.parse(
      read(folder + "/.generated/scene.bundle.json"),
    );
    const goal = read(folder + "/task-spec.json");
    const raw = readFileSync("public" + decodeURIComponent(bundle.model_url));
    const bytes = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    ) as ArrayBuffer;
    if (count === 1) {
      bundle.process.task.jobs = (bundle.process.task.jobs as unknown[]).slice(
        0,
        1,
      );
      bundle.process.task.material_count = 1;
      bundle.devices = bundle.devices.filter(
        (d) => d.asset_kind !== "runtime_material" || d.instance_id === "M01",
      );
      goal.expected.material_ids = ["M01"];
      goal.expected.material_count = 1;
      goal.all[0].items = goal.all[0].items.slice(0, 1);
    }
    const { program } =
      count === 1
        ? await assembleSceneRuntime(
            "S04-single",
            "run-single",
            compileSceneRuntime(bundle, bytes, goal, "validation"),
          )
        : await prepareImported();
    expect(program.snapshot().status).toBe("ready");
    program.start();
    let snapshot = program.snapshot();
    for (let i = 0; i < 50000 && program.needsStep(); i++)
      snapshot = program.step(1 / 60);
    const state = snapshot.observations.samples["handoff/state"]?.value as {
      transfers: { material: string; from: string; to: string; tick: number }[];
      placed: string[];
      delivered: { material: string; target: string; tick: number }[];
      arms: Record<string, { atHome: boolean; held?: string }>;
    };
    expect(
      snapshot.status,
      JSON.stringify({
        error: snapshot.error,
        last: snapshot.process.activations.slice(-6),
        state,
        tick: snapshot.tick,
      }),
    ).toBe("succeeded");
    expect(state.transfers).toHaveLength(count);
    expect(state.placed).toHaveLength(count);
    expect(state.delivered.map((d) => d.material)).toEqual(
      goal.expected.material_ids,
    );
    expect(
      state.transfers.every(
        (r, i) =>
          r.from === "R1" && r.to === "R2" && r.tick < state.delivered[i].tick,
      ),
    ).toBe(true);
    expect(Object.values(state.arms).every((a) => a.atHome && !a.held)).toBe(
      true,
    );
    expect(snapshot.process.resources).toEqual({});
    console.log(`S04 ${count} bottle(s) at tick ${snapshot.tick}`);
    program.dispose();
  },
  120000,
);

async function prepareImported() {
  const project = useWorkspace.getState().project;
  const previous = globalThis.fetch;
  let model: Blob | undefined;
  const puts = vi
    .spyOn(projectRepository, "putAsset")
    .mockImplementation(async (_id, b) => {
      model = b;
    });
  const gets = vi
    .spyOn(projectRepository, "getAsset")
    .mockImplementation(async () => model);
  globalThis.fetch = async (url) =>
    new Response(readFileSync("public" + decodeURIComponent(String(url))));
  try {
    useWorkspace.getState().initialize();
    const entry = (await fetchSceneCatalog()).find((e) => e.id === "S04")!;
    const id = await importScenePackage(entry);
    const scene = useWorkspace
      .getState()
      .project!.scenePackages!.find((s) => s.id === id)!;
    return await prepareScenePackage(
      scene,
      "validation",
      new AbortController().signal,
    );
  } finally {
    puts.mockRestore();
    gets.mockRestore();
    globalThis.fetch = previous;
    useWorkspace.setState({ project, activeSceneId: null });
  }
}

it("stops a suspended handoff without releasing the bottle or admitting another", async () => {
  const { program } = await prepareImported();
  program.start();
  let snapshot = program.snapshot();
  for (let i = 0; i < 9000 && program.needsStep(); i++) {
    snapshot = program.step(1 / 60);
    if (
      snapshot.signals.samples[
        `${snapshot.sceneInstanceId}/R2/holding_material`
      ]?.value === true
    )
      break;
  }
  expect(
    snapshot.signals.samples[`${snapshot.sceneInstanceId}/R2/holding_material`]
      ?.value,
  ).toBe(true);
  program.stop();
  while (program.needsStep()) snapshot = program.step(1 / 60);
  expect(snapshot.status).toBe("attention_required");
  const halted = snapshot.observations.samples["handoff/state"].value as {
    arms: Record<string, { held?: string }>;
    delivered: unknown[];
    active: string;
  };
  expect(halted.arms.R2.held).toBe("M01");
  expect(halted.active).toBe("M01");
  expect(halted.delivered).toEqual([]);
  program.discard();
}, 60000);

import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { sceneFixture } from "./fixtures";
import { BottleHandoffLine } from "../../src/runtime/services/BottleHandoffLine";
import { createJoltBackend } from "../../src/runtime/physics/jolt/JoltPhysicsBackend";
import {
  childrenOf,
  decodeProcessNode,
  type ProcessNode,
} from "../../src/contracts/process-ir";
import type { FactReceipt } from "../../src/domain/runtime/compileSignalConnections";
import { compileSceneLadder } from "../../src/domain/runtime/compileSceneLadder";
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

it.each([
  { count: 1, canonical: false },
  { count: 4, canonical: false },
  { count: 1, canonical: true },
  { count: 4, canonical: true },
])(
  "transfers $count bottle(s) and delivers them inverted in Jolt (canonical=$canonical)",
  async ({ count, canonical }) => {
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
    if (canonical) {
      const root = decodeProcessNode(bundle.process.body);
      const specialize = (n: ProcessNode) => {
        if (
          n.kind === "invoke" &&
          ["pick_and_handoff", "place_held_material"].includes(n.behavior)
        ) {
          // Keep the instance-qualified payload identifying its start and receiver.
          bundle.calls.find((c) => c.node === n.id)!.behavior =
            "pick_and_place";
          n.behavior = "pick_and_place";
        }
        childrenOf(n).forEach(specialize);
      };
      specialize(root);
      bundle.process.body = root;
      const rungs = compileSceneLadder(bundle).rungs.filter(
        (r) => r.behavior === "pick_and_place",
      );
      expect(rungs).toHaveLength(2);
      expect(rungs.map((r) => r.conditions.at(-1)?.key)).toEqual([
        "R1/pick_and_handoff.complete",
        "R2/place_held_material.complete",
      ]);
    }
    const { program, compiled } =
      count === 1 || canonical
        ? await assembleSceneRuntime(
            "S04-test",
            "run-test",
            compileSceneRuntime(bundle, bytes, goal, "validation"),
          )
        : await prepareImported();
    expect(program.snapshot().status).toBe("ready");
    program.start();
    let snapshot = program.snapshot();
    for (let i = 0; i < 50000 && program.needsStep(); i++)
      snapshot = program.step(1 / 60);
    const state = snapshot.observations.samples["handoff/state"]?.value as {
      factReceipts: FactReceipt[];
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
    const connections = compiled.handoff!.connections;
    for (const id of goal.expected.material_ids as string[]) {
      const edges = connections.get(id)!;
      expect(edges).toHaveLength(3);
      expect(edges).toContainEqual({
        producer: "head_to_tail_handoff",
        consumer: "place_head_down",
        alternatives: [],
        semantic: "held_by",
        subject: id,
        endpoint: "R2",
      });
      const receipts = state.factReceipts.filter((r) => r.fact.subject === id);
      expect(receipts).toHaveLength(3);
      const [grasp] = receipts.filter((r) => r.fact.semantic === "held_by");
      expect(grasp.fact.endpoint).toBe("R2");
      const producer = snapshot.process.activations.find(
        (a) => a.id === grasp.activationId,
      )!;
      const consumer = snapshot.process.activations.find(
        (a) => a.node === "place_head_down" && a.subjectId === id,
      )!;
      expect(producer).toMatchObject({
        node: "head_to_tail_handoff",
        state: "succeeded",
        subjectId: id,
        requestId: grasp.requestId,
      });
      expect(grasp.runId).toBe(snapshot.runId);
      expect(consumer.parentId).toBe(producer.parentId);
      expect(consumer.requestId).not.toBe(grasp.requestId);
    }
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

it("rejects a held-start step before the producer of its gripper ownership", () => {
  const { bundle, bytes, goal } = sceneFixture("S04");
  const root = decodeProcessNode(bundle.process.body);
  function reorder(n: ProcessNode) {
    if (
      n.kind === "seq" &&
      n.children.some((child) => child.id === "place_head_down")
    ) {
      const placed = n.children.findIndex(
        (child) => child.id === "place_head_down",
      );
      const giving = n.children.findIndex(
        (child) => child.id === "head_to_tail_handoff",
      );
      n.children.splice(giving, 0, ...n.children.splice(placed, 1));
    }
    childrenOf(n).forEach(reorder);
  }
  reorder(root);
  bundle.process.body = root;
  expect(() => compileSceneRuntime(bundle, bytes, goal, "validation")).toThrow(
    /held_by.*缺少可达的生产者/,
  );
});

it("checks the actual receiver grip and frame before a held-start request", async () => {
  const { bundle, bytes, goal } = sceneFixture("S04"),
    compiled = compileSceneRuntime(bundle, bytes, goal, "validation");
  const physics = await createJoltBackend(compiled.physics);
  try {
    const line = new BottleHandoffLine(compiled, physics),
      cfg = compiled.handoff!,
      arm = line.arm(cfg.receiver);
    const material = cfg.jobs[0].material,
      body = line.body(material);
    if (!physics.isBodyActive!(body.id))
      physics.activateBodies!([
        {
          id: body.id,
          pose: {
            position: body.position,
            rotation: body.rotation,
            velocity: [0, 0, 0],
          },
        },
      ]);
    const place = (grasp: string) =>
      line.prepare({
        runId: "run",
        activationId: "place",
        requestId: "1",
        device: cfg.receiver,
        behavior: "pick_and_place",
        arguments: {},
        payload: {
          binding: cfg.receiver + ".place_held_material",
          fields: { material, grasp, target: cfg.outfeed + ".entry" },
        },
      });
    expect(() => place("tail")).toThrow(/持件起点/);
    physics.createGrasp!(arm.graspId, arm.scene.toolBodyId, body.id);
    arm.attach(material, physics.readBody!(body.id), "tail");
    expect(() => place("head")).toThrow(/持件起点/);
    expect(physics.hasGrasp!(arm.graspId)).toBe(true);
  } finally {
    physics.dispose();
  }
});

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
  const { factReceipts } = snapshot.observations.samples["handoff/state"]
    .value as { factReceipts: FactReceipt[] };
  expect(factReceipts.some((r) => r.fact.semantic === "held_by")).toBe(false);
  expect(halted.active).toBe("M01");
  expect(halted.delivered).toEqual([]);
  program.discard();
}, 60000);

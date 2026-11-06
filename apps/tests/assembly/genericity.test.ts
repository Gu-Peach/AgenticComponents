import { it, expect } from "vitest";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";
import { assembleSceneRuntime } from "../../src/runtime/assembly/SceneRuntimeAssembler";
import { sceneBundleSchema } from "../../src/contracts/scene-package";
import { sceneFixture } from "./fixtures";

it("derives finite inventory and goals from a second one-pallet configuration", async () => {
  const { bundle, bytes, goal } = sceneFixture();
  const task = bundle.process.task as {
    pallets: { id: string; items: { material: string }[] }[];
    pallet_count: number;
    material_count: number;
  };
  task.pallets = task.pallets.slice(0, 1);
  task.pallet_count = 1;
  task.material_count = task.pallets[0].items.length;
  bundle.devices = bundle.devices.filter(
    (d) => d.creation_policy !== "clone_on_admission",
  );
  goal.expected.pallet_ids = [task.pallets[0].id];
  goal.expected.material_ids = task.pallets[0].items.map((i) => i.material);
  goal.expected.pallet_count = 1;
  goal.expected.material_count = task.material_count;
  for (const clause of goal.all) {
    if (clause.kind === "category_deliveries")
      clause.items = clause.items.filter((i: { material: string }) =>
        goal.expected.material_ids.includes(i.material),
      );
    if (clause.kind === "all_pallets_empty_and_exited")
      clause.ids = goal.expected.pallet_ids;
  }
  const compiled = compileSceneRuntime(bundle, bytes, goal, "validation");
  expect(compiled.task.pallets).toHaveLength(1);
  expect(compiled.goals.material_ids).toHaveLength(12);
  expect(
    [...compiled.robots.keys()].every(
      (id) => compiled.robotNodes.get(id)?.length === 6,
    ),
  ).toBe(true);
  const assembled = await assembleSceneRuntime(
    "smaller",
    "one-pallet",
    compiled,
  );
  assembled.program.dispose();
});

it("assembles renamed devices and independent instances with isolated signal namespaces", async () => {
  const { bundle, bytes, goal } = sceneFixture();
  const names = new Map(
    bundle.devices.map((d, i) => [d.instance_id, "Asset" + i]),
  );
  names.set("S01", "S99");
  const substitute = (s: string) =>
    s.replace(
      /\b(?:S01|R1|R2|C1|C2|C3|C4|F1|Pallet|Material|P0[123]|M0[123]_\d\d)\b/g,
      (name) => names.get(name) ?? name,
    );
  const rename = (value: unknown): unknown =>
    typeof value === "string"
      ? substitute(value)
      : Array.isArray(value)
        ? value.map(rename)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [substitute(k), rename(v)]),
            )
          : value;
  const compiled = compileSceneRuntime(
    sceneBundleSchema.parse(rename(bundle)),
    bytes,
    rename(goal),
    "validation",
  );
  const a = await assembleSceneRuntime("scene-a", "run-a", compiled),
    b = await assembleSceneRuntime("scene-b", "run-b", compiled);
  try {
    expect(
      a.program.signals.layout().every((s) => s.key.startsWith("scene-a/")),
    ).toBe(true);
    expect(
      b.program.signals.layout().every((s) => s.key.startsWith("scene-b/")),
    ).toBe(true);
    a.program.start();
    a.program.step(1 / 60);
    expect(b.program.snapshot().tick).toBe(0);
    a.program.stop();
    for (let i = 0; i < 300 && a.program.needsStep(); i++)
      a.program.step(1 / 60);
  } finally {
    a.program.dispose();
    b.program.dispose();
  }
});
it("rejects conflicting ownership, incomplete task identities and unsupported behavior, then prepares a clean world", async () => {
  const { bundle, bytes, goal } = sceneFixture();
  const duplicate = structuredClone(bundle);
  duplicate.devices[1].node_binding.owned_mesh_indices =
    duplicate.devices[0].node_binding.owned_mesh_indices;
  expect(() =>
    compileSceneRuntime(duplicate, bytes, goal, "validation"),
  ).toThrow(/ownership/);
  expect(() =>
    compileSceneRuntime(
      bundle,
      bytes,
      { ...goal, expected: { ...goal.expected, material_ids: [] } },
      "validation",
    ),
  ).toThrow(/identities/);
  const bad = structuredClone(bundle);
  bad.calls[0].behavior = "unsupported_behavior";
  const compiled = compileSceneRuntime(bad, bytes, goal, "validation");
  await expect(
    assembleSceneRuntime("bad", "bad-run", compiled),
  ).rejects.toThrow(/executor/);
  const valid = await assembleSceneRuntime(
    "valid",
    "valid-run",
    compileSceneRuntime(bundle, bytes, goal, "validation"),
  );
  valid.program.dispose();
});

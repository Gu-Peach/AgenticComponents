import { writeFileSync } from "node:fs";
import { it, expect } from "vitest";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";
import { assembleSceneRuntime } from "../../src/runtime/assembly/SceneRuntimeAssembler";
import { sceneFixture } from "./fixtures";
import type { EnvironmentReceipt } from "../../src/runtime/engine/FiniteBatchLifecycle";

it("completes all three pallets and 36 deliveries with actual parallel robot execution", async () => {
  const { bundle, bytes, goal } = sceneFixture();
  const compiled = compileSceneRuntime(bundle, bytes, goal, "validation");
  const { program } = await assembleSceneRuntime(
    "integration-scene",
    "integration-run",
    compiled,
    {
      conditionMode:
        process.env.AC_CONDITION_MODE === "compare"
          ? "compare"
          : process.env.AC_CONDITION_MODE === "legacy"
            ? "legacy"
            : "expression",
    },
  );
  let last = program.snapshot(),
    overlapTicks = 0;
  const states = new Map<string, string>(),
    trace: {
      tick: number;
      node: string;
      activation: string;
      state: string;
      request?: string;
    }[] = [];
  program.start();
  for (let i = 0; i < 72000 && program.needsStep(); i++) {
    last = program.step(1 / 60);
    if (
      [...compiled.robots.keys()].filter(
        (id) =>
          last.signals.samples[`integration-scene/${id}/busy`]?.value === true,
      ).length > 1
    )
      overlapTicks++;
    for (const a of last.process.activations)
      if (states.get(a.id) !== a.state) {
        states.set(a.id, a.state);
        trace.push({
          tick: last.tick,
          node: a.node,
          activation: a.id,
          state: a.state,
          request: a.requestId,
        });
      }
  }
  const world = last.observations.samples["world/state"]?.value as {
    receipts: EnvironmentReceipt[];
    deliveries: Record<string, { handler: string; target: string }>;
    robotClear: Record<string, boolean>;
  };
  const report = {
    conditionMode: last.conditions?.mode,
    conditionComparisons: last.conditions?.comparisons,
    conditionMismatches: last.conditions?.mismatches,
    conditionDecisions: last.conditions?.events,
    modelSha256: bundle.model_sha256,
    sourceHashes: bundle.source_hashes,
    status: last.status,
    ticks: last.tick,
    error: last.error,
    overlapTicks,
    receipts: world.receipts,
    deliveries: world.deliveries,
    resources: last.process.resources,
    trace,
  };
  if (process.env.AC_SCENE_REPORT)
    writeFileSync(
      process.env.AC_SCENE_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
  expect(
    last.status,
    JSON.stringify({
      tick: last.tick,
      error: last.error,
      steps: last.process.activations.slice(-12),
      receipts: world.receipts.slice(-4),
    }),
  ).toBe("succeeded");
  expect(
    world.receipts
      .filter((r) => r.kind === "material_delivered")
      .map((r) => r.subjectId)
      .sort(),
  ).toEqual([...compiled.goals.material_ids].sort());
  expect(
    world.receipts
      .filter((r) => r.kind === "carrier_departed")
      .map((r) => r.subjectId)
      .sort(),
  ).toEqual([...compiled.goals.pallet_ids].sort());
  for (const delivery of compiled.goals.deliveries)
    expect(world.deliveries[delivery.material]).toMatchObject({
      handler: delivery.handler,
      target: delivery.target,
    });
  expect(overlapTicks).toBeGreaterThan(0);
  expect(last.process.resources).toEqual({});
  expect(Object.values(world.robotClear).every(Boolean)).toBe(true);
  console.log(
    `S01: ${last.tick} ticks, ${overlapTicks} overlapping robot ticks, ${compiled.goals.material_ids.length} deliveries`,
  );
  program.dispose();
// Real Jolt replay is CPU-bound; slower desktop runs exceed two minutes.
// Keep all physical/identity assertions while allowing four minutes wall time.
}, 240000);

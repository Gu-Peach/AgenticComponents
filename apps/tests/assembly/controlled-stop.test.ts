import { it, expect } from "vitest";
import { sceneFixture } from "./fixtures";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";
import { assembleSceneRuntime } from "../../src/runtime/assembly/SceneRuntimeAssembler";
it("stops the moving mainline without supplying another pallet and releases request resources", async () => {
  const { bundle, bytes, goal } = sceneFixture();
  const { program } = await assembleSceneRuntime(
    "stop-scene",
    "stop-run",
    compileSceneRuntime(bundle, bytes, goal, "validation"),
  );
  program.start();
  for (let i = 0; i < 120; i++) program.step(1 / 60);
  expect(
    program.snapshot().signals.samples["stop-scene/C2/runningTag"].value,
  ).toBe(true);
  program.stop();
  for (let i = 0; i < 600 && program.needsStep(); i++) program.step(1 / 60);
  const snapshot = program.snapshot();
  expect(snapshot.status, JSON.stringify(snapshot.process)).toBe("cancelled");
  expect(snapshot.process.resources).toEqual({});
  const world = snapshot.observations.samples["world/state"].value as {
    receipts: { kind: string }[];
  };
  expect(
    world.receipts.filter((r) => r.kind === "supply_requested"),
  ).toHaveLength(1);
  program.dispose();
});

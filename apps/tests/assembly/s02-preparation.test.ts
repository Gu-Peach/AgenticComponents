import { readFileSync } from "node:fs";
import { Vector3, Quaternion } from "three";
import { it, expect, vi, afterEach } from "vitest";
import {
  fetchSceneCatalog,
  importScenePackage,
} from "../../src/services/PublicSceneCatalog";
import { prepareScenePackage } from "../../src/services/prepareScenePackage";
import { projectRepository } from "../../src/services/BrowserProjectRepository";
import { useWorkspace } from "../../src/stores/workspace";
import type { SceneConditionWorld } from "../../src/runtime/assembly/SceneConditionBindings";
import { RobotKinematics } from "../../src/runtime/kinematics/RobotKinematics";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("repeats three top picks from the same R1 rest configuration on the loading line", async () => {
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(readFileSync("public" + decodeURIComponent(url))),
  );
  const assets = new Map<string, Blob>();
  vi.spyOn(projectRepository, "putAsset").mockImplementation(async (id, b) => {
    assets.set(id, b);
  });
  vi.spyOn(projectRepository, "getAsset").mockImplementation(async (id) =>
    assets.get(id),
  );
  useWorkspace.getState().initialize();
  const entry = (await fetchSceneCatalog()).find((e) => e.id === "S02")!;
  const id = await importScenePackage(entry);
  const scene = useWorkspace
    .getState()
    .project!.scenePackages!.find((p) => p.id === id)!;
  const { compiled, program } = await prepareScenePackage(
    scene,
    "validation",
    new AbortController().signal,
  );
  let snapshot = program.snapshot();
  const world = () =>
    snapshot.observations.samples["world/state"].value as SceneConditionWorld;
  expect(snapshot.status).toBe("ready");
  expect(snapshot.tick).toBe(0);
  expect(compiled.loading?.materialSupply.size).toBe(150);
  expect(world().loading?.slots).toEqual({});
  const admitted = world()
    .receipts.filter((r) => r.kind === "supply_confirmed")
    .map((r) => r.subjectId)
    .sort();
  expect(admitted).toEqual(["M01_01", "M01_13", "M01_14", "P01"]);
  const active = [...compiled.subjectIds.keys()].filter(
    (subject) => world().bodies[subject + "/body"].active,
  );
  expect(active.sort()).toEqual(admitted);
  expect(world().receipts.every((r) => r.tick === 0)).toBe(true);
  const origin = world().bodies["P01/body"].pose!.position;
  const fk = new RobotKinematics(compiled.robots.get("R1")!);
  const pickupElbows = new Map<string, number>();
  let returns = 0;
  program.start();
  for (let i = 0; i < 10000 && program.needsStep(); i++) {
    snapshot = program.step(1 / 60);
    const sample = snapshot.observations.samples["R1/robot_state"];
    const arm = sample?.value as
      { q: number[]; holding: boolean; phase: string } | undefined;
    if (
      arm?.holding &&
      arm.phase.endsWith(" grip") &&
      sample.subjectId &&
      !pickupElbows.has(sample.subjectId)
    ) {
      const pose = fk.forward(arm.q);
      pickupElbows.set(sample.subjectId, pose.joints[2].pivot.y);
      // On this GLB the outward tool axis is local +Z. Check at actual capture.
      const approach = new Vector3(0, 0, 1).applyQuaternion(
        new Quaternion(...pose.tcp.rotation),
      );
      expect(approach.angleTo(new Vector3(0, -1, 0))).toBeLessThan(0.01);
    }
    const completed = snapshot.process.activations.filter(
      (a) => a.node === "retreat_lower" && a.state === "succeeded",
    ).length;
    if (completed > returns) {
      expect(Math.max(...arm!.q.map(Math.abs))).toBeLessThan(1e-6);
      returns = completed;
      if (returns === 3) break;
    }
  }
  expect(
    snapshot.process.activations.find((a) => a.node === "index_to_lower")
      ?.state,
    JSON.stringify({
      error: snapshot.error,
      active: snapshot.process.activations.slice(-4),
    }),
  ).toBe("succeeded");
  expect(
    Math.abs(world().bodies["P01/body"].pose!.position[0] - origin[0]),
  ).toBeGreaterThan(1);
  expect(
    snapshot.process.activations.find((a) => a.node === "feed_lower")?.state,
    snapshot.error,
  ).toBe("succeeded");
  expect(world().loading?.slots["P01.lower01"], snapshot.error).toBe("M01_01");
  expect(world().loading?.slots["P01.lower02"], snapshot.error).toBe("M01_02");
  expect(world().loading?.slots["P01.lower03"], snapshot.error).toBe("M01_03");
  expect(returns, snapshot.error).toBe(3);
  expect(pickupElbows.size).toBe(3);
  const heights = [...pickupElbows.values()];
  expect(Math.min(...heights)).toBeGreaterThan(
    fk.forward([0, 0, 0, 0, 0, 0]).joints[1].pivot.y,
  );
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.01);
  program.stop();
  for (let i = 0; i < 1900 && program.needsStep(); i++)
    snapshot = program.step(1 / 60);
  expect(snapshot.status, snapshot.error).toBe("cancelled");
  program.dispose();
  const restarted = await prepareScenePackage(
    scene,
    "validation",
    new AbortController().signal,
  );
  expect(restarted.program.snapshot().status).toBe("ready");
  expect(restarted.program.snapshot().runId).not.toBe(snapshot.runId);
  restarted.program.dispose();
}, 60000);

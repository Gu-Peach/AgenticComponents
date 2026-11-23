import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  fetchSceneCatalog,
  importScenePackage,
} from "../src/services/PublicSceneCatalog";
import { projectRepository } from "../src/services/BrowserProjectRepository";
import { useWorkspace } from "../src/stores/workspace";
import { compileSceneLadder } from "../src/domain/runtime/compileSceneLadder";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("imports the measured loading line and projects its finite DSL onto work steps", async () => {
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(readFileSync("public" + decodeURIComponent(url))),
  );
  useWorkspace.getState().initialize();
  vi.spyOn(projectRepository, "putAsset").mockResolvedValue();
  const entry = (await fetchSceneCatalog()).find((s) => s.id === "S02")!;
  const id = await importScenePackage(entry);
  const scene = useWorkspace
    .getState()
    .project!.scenePackages!.find((s) => s.id === id)!;
  const bundle = scene.bundle;
  expect(entry.deviceCount).toBe(21);
  expect(bundle.process.task.material_count).toBe(150);
  const ladder = compileSceneLadder(bundle);
  for (const category of ["lower", "cover", "upper"]) {
    expect(
      ladder.rungs.find((r) => r.id === "place_" + category)?.behavior,
    ).toBe("pick_and_place");
  }
  for (let n = 1; n <= 6; n++) {
    const key = "P" + String(n).padStart(2, "0");
    const pallet = bundle.devices.find((d) => d.instance_id === key)!;
    expect(pallet.initial_inventory).toEqual({ contents: [] });
    expect(Object.keys(pallet.locations as object)).toHaveLength(25);
    const items = bundle.devices.filter((d) =>
      d.instance_id.startsWith("M" + key.slice(1) + "_"),
    );
    expect(items.map((i) => i.prototype_ref)).toEqual([
      ...Array(12).fill("LowerPart"),
      "Cover",
      ...Array(12).fill("UpperPart"),
    ]);
    expect(items.map((i) => i.initial_supply)).toEqual([
      ...Array(12).fill("F1"),
      "F2",
      ...Array(12).fill("F3"),
    ]);
  }
});

import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { projectRepository } from "../src/services/BrowserProjectRepository";
import {
  fetchSceneCatalog,
  importScenePackage,
} from "../src/services/PublicSceneCatalog";
import { useWorkspace } from "../src/stores/workspace";

afterEach(() => {
  useWorkspace.setState({ documentLocked: false });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("retains the PLC scene across viewport selections, locks, restore and removal", async () => {
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(readFileSync("public" + decodeURIComponent(url))),
  );
  vi.spyOn(projectRepository, "putAsset").mockResolvedValue();
  const workspace = useWorkspace.getState;
  workspace().initialize();
  useWorkspace.setState({ dock: "terminal", dockOpen: false });
  const entry = (await fetchSceneCatalog()).find((s) => s.id === "S02")!;
  const first = await importScenePackage(entry);
  expect(workspace()).toMatchObject({
    activeSceneId: first,
    dock: "plc",
    dockOpen: true,
  });

  const firstScene = workspace().project!.scenePackages![0];
  const firstDefinition = workspace().project!.definitions[0];
  const second = await importScenePackage(entry);
  expect(workspace().project!.scenePackages).toHaveLength(1);
  // Imported project files can still contain multiple scenes.
  workspace().updateProject((p) => ({
    ...p,
    scenePackages: [firstScene, ...p.scenePackages!],
  }));
  workspace().add(firstDefinition);

  const savedProject = workspace().project!;
  const device = savedProject.instances[0].instanceId;
  expect(workspace().activeSceneId).toBe(second);
  workspace().select(device);
  workspace().select(null);
  expect(workspace()).toMatchObject({
    selectedId: null,
    activeSceneId: second,
  });
  useWorkspace.setState({ dock: "terminal" });
  workspace().setActiveScene(first);
  expect(workspace()).toMatchObject({
    activeSceneId: first,
    selectedId: null,
    dock: "terminal",
  });

  useWorkspace.setState({ documentLocked: true });
  workspace().select(second);
  workspace().setActiveScene(second);
  expect(workspace()).toMatchObject({
    selectedId: second,
    activeSceneId: first,
  });
  useWorkspace.setState({ documentLocked: false });
  workspace().initialize(savedProject);
  expect(workspace()).toMatchObject({
    activeSceneId: second,
    dock: "plc",
    dockOpen: true,
  });
  workspace().updateProject((p) => ({
    ...p,
    scenePackages: p.scenePackages?.filter((s) => s.id !== second),
  }));
  expect(workspace().activeSceneId).toBe(first);
  workspace().updateProject((p) => ({ ...p, scenePackages: [] }));
  expect(workspace().activeSceneId).toBeNull();
  workspace().initialize();
  expect(workspace()).toMatchObject({ activeSceneId: null, dock: "plc" });
});

import { clearScene } from "../src/commands/sceneCommands";
import { useInteraction } from "../src/stores/interaction";
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  sceneIndexSchema,
  sceneBundleSchema,
  sceneBundleAssets,
  isSceneUrl,
} from "../src/contracts/scene-package";
import {
  fetchSceneAssets,
  fetchSceneBundle,
  importScenePackage,
} from "../src/services/PublicSceneCatalog";
import { sceneModules } from "../src/domain/runtime/sceneModules";
import { useWorkspace } from "../src/stores/workspace";
import { projectRepository } from "../src/services/BrowserProjectRepository";
import { parseProject } from "../src/validation/contracts";
const entries = sceneIndexSchema.parse(
  JSON.parse(readFileSync("public/scene/index.json", "utf8")),
).entries;
function serve() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(readFileSync("public" + decodeURIComponent(url))),
    ),
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("scene packages", () => {
  it("compiles all twelve from device and process, preserving honest blockers", () => {
    expect(entries).toHaveLength(12);
    for (const entry of entries) {
      const bundle = sceneBundleSchema.parse(
        JSON.parse(readFileSync("public" + entry.bundleUrl, "utf8")),
      );
      expect(entry.assets).toEqual(sceneBundleAssets(bundle));
      expect(entry.assets).toHaveLength(entry.deviceCount);
      expect(bundle.id).toBe(entry.id);
      expect(bundle.executable).toBe(false);
      expect(bundle.blockers.length).toBeGreaterThan(0);
      const modules = sceneModules(bundle);
      expect(modules.length).toBeGreaterThan(0);
      expect(bundle.source_hashes["batch.json"]).toBeUndefined();
      expect(bundle.source_hashes["bindings.json"]).toBeUndefined();
    }
  });
  it("lists prototypes and experimental assets, fetching a bundle only for an old index", async () => {
    serve();
    const loading = entries.find((e) => e.id === "S02")!;
    const assets = await fetchSceneAssets(loading);
    expect(assets).toContainEqual(expect.objectContaining({ id: "Pallet" }));
    expect(assets.some((asset) => asset.id === "P01")).toBe(false);
    expect(entries.find((e) => e.id === "S05")?.assets).toContainEqual({
      id: "D1",
      type: "processing_station",
      name: "加工设备",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await fetchSceneAssets({ ...loading, assets: undefined })).toEqual(
      assets,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(loading.bundleUrl, {
      cache: "no-store",
    });
  });
  it("rejects traversal, malformed encoding and duplicate scene IDs", () => {
    for (const path of [
      "/scene/S01/../secret",
      "/scene/S01/%2e%2e/secret",
      "/scene/S01/%2fsecret",
      "/scene/S01/%zz",
      "https://evil.test/a",
    ])
      expect(isSceneUrl(path)).toBe(false);
    expect(() =>
      sceneIndexSchema.parse({ version: 1, entries: [entries[0], entries[0]] }),
    ).toThrow();
  });
  it("rejects source hash drift even if generated bundle hash still matches", async () => {
    serve();
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/process.py") ? new Response("changed") : original(url),
      ),
    );
    await expect(fetchSceneBundle(entries[0])).rejects.toThrow("哈希");
  });
  it("replaces placed content while retaining project identity and the asset catalog", async () => {
    serve();
    useWorkspace.getState().initialize();
    useWorkspace
      .getState()
      .updateProject((p) => ({
        ...p,
        plc: "PROGRAM Old END_PROGRAM",
        connections: [],
      }));
    useWorkspace.setState({
      modelErrors: { obsolete: "failed" },
      modelNodes: { obsolete: ["node"] },
    });
    vi.spyOn(projectRepository, "putAsset").mockResolvedValue();
    const original = useWorkspace.getState().project!;
    const first = await importScenePackage(entries[0]);
    expect(useWorkspace.getState().project!.instances).toEqual([]);
    const second = await importScenePackage(entries[0]);
    const project = useWorkspace.getState().project!;
    expect(project.id).toBe(original.id);
    expect(project.definitions).toBe(original.definitions);
    expect(project.scenePackages?.map((s) => s.id)).toEqual([second]);
    expect(second).not.toBe(first);
    expect(project.connections).toEqual([]);
    expect(project.plc).toBe("");
    expect(project.assets).toHaveLength(1);
    expect(useWorkspace.getState()).toMatchObject({
      activeSceneId: second,
      selectedId: second,
      modelErrors: {},
      modelNodes: {},
    });
    expect(
      parseProject(JSON.parse(JSON.stringify(project))).scenePackages,
    ).toHaveLength(1);
  });
  it("keeps the current scene when downloading a replacement fails", async () => {
    serve();
    useWorkspace.getState().initialize();
    const before = useWorkspace.getState();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    await expect(importScenePackage(entries[0])).rejects.toThrow("读取失败");
    expect(useWorkspace.getState().project).toBe(before.project);
    expect(useWorkspace.getState().selectedId).toBe(before.selectedId);
  });
  it("keeps the current scene on storage failure and admits only one concurrent replacement", async () => {
    serve();
    useWorkspace.getState().initialize();
    const before = useWorkspace.getState().project!;
    vi.spyOn(projectRepository, "putAsset").mockRejectedValueOnce(
      new Error("storage error"),
    );
    await expect(importScenePackage(entries[0])).rejects.toThrow(
      "storage error",
    );
    expect(useWorkspace.getState().project).toBe(before);
    vi.mocked(projectRepository.putAsset).mockResolvedValue(undefined);
    const attempts = await Promise.allSettled([
      importScenePackage(entries[0]),
      importScenePackage(entries[1]),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(useWorkspace.getState().project?.scenePackages).toHaveLength(1);
  });
  it("clears scene state and lets catalog assets be added again", async () => {
    serve();
    useWorkspace.getState().initialize();
    vi.spyOn(projectRepository, "putAsset").mockResolvedValue();
    await importScenePackage(entries[0]);
    const before = useWorkspace.getState().project!;
    useWorkspace.getState().select(before.scenePackages![0].id, "C1");
    useInteraction.setState({
      drag: {
        instanceId: "old",
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      },
      suppressClickUntil: 123,
    });
    await clearScene();
    expect(useWorkspace.getState().project).toMatchObject({
      id: before.id,
      name: before.name,
      instances: [],
      scenePackages: [],
      connections: [],
      plc: "",
      revision: before.revision + 1,
    });
    expect(useWorkspace.getState().project!.definitions).toBe(
      before.definitions,
    );
    expect(useWorkspace.getState().project!.assets).toBe(before.assets);
    expect(useWorkspace.getState()).toMatchObject({
      selectedId: null,
      selectedSceneDeviceId: null,
      activeSceneId: null,
      modelErrors: {},
      modelNodes: {},
      dirty: true,
    });
    expect(useInteraction.getState()).toMatchObject({
      drag: null,
      candidate: null,
      suppressClickUntil: 0,
    });
    useWorkspace.getState().add(before.definitions[0]);
    expect(useWorkspace.getState().project!.instances).toHaveLength(1);
  });
  it("rejects scene cleanup and replacement while the document is locked", async () => {
    serve();
    useWorkspace.getState().initialize();
    const before = useWorkspace.getState().project!;
    useWorkspace.setState({ documentLocked: true });
    try {
      await expect(clearScene()).rejects.toThrow("重置");
      await expect(importScenePackage(entries[0])).rejects.toThrow("停止");
      expect(useWorkspace.getState().project).toBe(before);
    } finally {
      useWorkspace.setState({ documentLocked: false });
    }
  });
  it("does not clear a newer project after an asynchronous reset", async () => {
    useWorkspace.getState().initialize();
    const clearing = clearScene();
    useWorkspace.getState().initialize();
    const later = useWorkspace.getState().project!;
    await expect(clearing).rejects.toThrow("项目已改变");
    expect(useWorkspace.getState().project).toBe(later);
  });
  it("does not commit when project changes during model storage", async () => {
    serve();
    useWorkspace.getState().initialize();
    vi.spyOn(projectRepository, "putAsset").mockImplementation(async () => {
      useWorkspace.getState().initialize();
    });
    await expect(importScenePackage(entries[0])).rejects.toThrow("项目已改变");
    expect(useWorkspace.getState().project?.scenePackages).toBeUndefined();
  });
});

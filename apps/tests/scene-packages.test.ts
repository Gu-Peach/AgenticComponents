import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  sceneIndexSchema,
  sceneBundleSchema,
  isSceneUrl,
} from "../src/contracts/scene-package";
import {
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
      expect(bundle.id).toBe(entry.id);
      expect(bundle.executable).toBe(false);
      expect(bundle.blockers.length).toBeGreaterThan(0);
      const modules = sceneModules(bundle);
      expect(modules.length).toBeGreaterThan(0);
      expect(bundle.source_hashes["batch.json"]).toBeUndefined();
      expect(bundle.source_hashes["bindings.json"]).toBeUndefined();
    }
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
  it("imports separate scene instances without duplicating geometry or replacing the project", async () => {
    serve();
    useWorkspace.getState().initialize();
    vi.spyOn(projectRepository, "putAsset").mockResolvedValue();
    const original = useWorkspace.getState().project!;
    await importScenePackage(entries[0]);
    await importScenePackage(entries[0]);
    const project = useWorkspace.getState().project!;
    expect(project.instances).toEqual(original.instances);
    expect(project.scenePackages).toHaveLength(2);
    expect(new Set(project.scenePackages!.map((s) => s.id)).size).toBe(2);
    expect(project.assets).toHaveLength(1);
    expect(
      parseProject(JSON.parse(JSON.stringify(project))).scenePackages,
    ).toHaveLength(2);
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

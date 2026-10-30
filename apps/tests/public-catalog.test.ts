import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { catalogIndexSchema } from "../src/contracts/catalog";
import { fetchPublicDefinition } from "../src/services/PublicModelCatalog";
import { useWorkspace } from "../src/stores/workspace";
import { addPublicAsset } from "../src/commands/workspaceCommands";
import { projectRepository } from "../src/services/BrowserProjectRepository";
const index = JSON.parse(readFileSync("public/modles/index.json", "utf8"));
const entry = index.entries[0];
function serve() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(readFileSync(`public${decodeURIComponent(url)}`)),
    ),
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("public model packages", () => {
  it("loads the real schema including import transform and spatial interfaces", async () => {
    serve();
    const d = await fetchPublicDefinition(entry);
    expect(d.specId).toBe("Conveyor_aankws");
    expect(d.asset.importTransform?.scale).toEqual([1, 1, 1]);
    expect(d.spatialInterfaces).toHaveLength(2);
  });
  it("rejects traversal and duplicate IDs", () => {
    expect(() =>
      catalogIndexSchema.parse({
        ...index,
        entries: [{ ...entry, modelUrl: "/modles/../secret.glb" }],
      }),
    ).toThrow();
    expect(() =>
      catalogIndexSchema.parse({ ...index, entries: [entry, entry] }),
    ).toThrow();
  });
  it("rejects a mismatched hash", async () => {
    serve();
    await expect(
      fetchPublicDefinition({ ...entry, schemaSha256: "0".repeat(64) }),
    ).rejects.toThrow("哈希");
  });
  it("inserts atomically and reuses stored model bytes for a second instance", async () => {
    serve();
    useWorkspace.getState().initialize();
    const blobs = new Map<string, Blob>();
    vi.spyOn(projectRepository, "getAsset").mockImplementation(async (id) =>
      blobs.get(id),
    );
    vi.spyOn(projectRepository, "putAsset").mockImplementation(
      async (id, b) => {
        blobs.set(id, b);
      },
    );
    await addPublicAsset(entry);
    await addPublicAsset(entry);
    const p = useWorkspace.getState().project!;
    expect(p.definitions.filter((d) => d.specId === entry.specId)).toHaveLength(
      1,
    );
    expect(p.instances.filter((i) => i.specId === entry.specId)).toHaveLength(
      2,
    );
    expect(blobs.size).toBe(1);
    expect(p.assets[0].size).toBeGreaterThan(0);
  });
  it("does not commit an insertion if its project changed while awaiting the model", async () => {
    serve();
    useWorkspace.getState().initialize();
    vi.spyOn(projectRepository, "getAsset").mockImplementation(async () => {
      useWorkspace.getState().initialize();
      return undefined;
    });
    vi.spyOn(projectRepository, "putAsset").mockResolvedValue();
    await expect(addPublicAsset(entry)).rejects.toThrow("场景已改变");
    expect(
      useWorkspace
        .getState()
        .project!.definitions.some((d) => d.specId === entry.specId),
    ).toBe(false);
  });
  it("does not steal a later asset selection when an earlier insertion completes", async () => {
    serve();
    useWorkspace.getState().initialize();
    vi.spyOn(projectRepository, "getAsset").mockImplementation(async () => {
      useWorkspace.getState().selectAsset("keep-this-selection");
      return undefined;
    });
    vi.spyOn(projectRepository, "putAsset").mockResolvedValue();
    await addPublicAsset(entry);
    expect(useWorkspace.getState().selectedAsset).toBe("keep-this-selection");
    expect(useWorkspace.getState().addingAsset).toBeNull();
  });
});

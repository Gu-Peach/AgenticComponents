import {
  sceneIndexSchema,
  sceneBundleSchema,
  isSceneUrl,
  type SceneEntry,
} from "@/contracts/scene-package";
import { sha256, validateGlb } from "@/domain/validateGlb";
import { projectRepository } from "./BrowserProjectRepository";
import { useWorkspace } from "@/stores/workspace";

async function bytes(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`场景资源读取失败：${url}`);
  return response.arrayBuffer();
}
async function verified(url: string, hash: string) {
  if (!isSceneUrl(url)) throw new Error("场景资源路径无效");
  const value = await bytes(url);
  if ((await sha256(value)) !== hash)
    throw new Error(`场景资源哈希变化，请重新编译：${url}`);
  return value;
}
export async function fetchSceneCatalog() {
  return sceneIndexSchema.parse(
    JSON.parse(new TextDecoder().decode(await bytes("/scene/index.json"))),
  ).entries;
}
export async function fetchSceneBundle(entry: SceneEntry) {
  const bundle = sceneBundleSchema.parse(
    JSON.parse(
      new TextDecoder().decode(
        await verified(entry.bundleUrl, entry.bundleSha256),
      ),
    ),
  );
  if (bundle.id !== entry.id) throw new Error("场景目录与包身份不一致");
  await Promise.all(
    Object.entries(bundle.source_hashes).map(async ([path, hash]) => {
      await verified(
        `/scene/${bundle.id}/${path.split("/").map(encodeURIComponent).join("/")}`,
        hash,
      );
    }),
  );
  return bundle;
}
export async function importScenePackage(entry: SceneEntry) {
  const state = useWorkspace.getState(),
    project = state.project;
  if (!project || state.documentLocked)
    throw new Error("请先停止运行再导入场景");
  const bundle = await fetchSceneBundle(entry);
  const assetId = `scene-model-${bundle.model_sha256}`;
  const model = await verified(bundle.model_url, bundle.model_sha256);
  validateGlb(model);
  if (
    useWorkspace.getState().project !== project ||
    useWorkspace.getState().documentLocked
  )
    throw new Error("导入期间项目已改变");
  await projectRepository.putAsset(
    assetId,
    new Blob([model], { type: "model/gltf-binary" }),
  );
  if (
    useWorkspace.getState().project !== project ||
    useWorkspace.getState().documentLocked
  )
    throw new Error("导入期间项目已改变");
  const id = `${bundle.id}-${crypto.randomUUID()}`;
  state.updateProject((p) => ({
    ...p,
    scenePackages: [
      ...(p.scenePackages ?? []),
      { id, assetId, bundleHash: entry.bundleSha256, bundle },
    ],
    assets: p.assets.some((a) => a.id === assetId)
      ? p.assets
      : [
          ...p.assets,
          {
            id: assetId,
            name: bundle.id + ".glb",
            kind: "glb",
            size: model.byteLength,
          },
        ],
  }));
  useWorkspace.setState((s) => ({
    selectedId: id,
    activeSceneId: id,
    inspectorTarget: "scene",
    selectedInterface: null,
    dock: "plc",
    dockOpen: true,
    focusToken: s.focusToken + 1,
  }));
  state.log(
    `已导入 ${entry.id} 整场模型与工艺，${bundle.blockers.length} 项运行依赖待完成`,
  );
  return id;
}

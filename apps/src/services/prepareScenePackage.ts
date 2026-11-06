import type { ScenePackageInstance } from "@/contracts/scene-package";
import { isSceneUrl, sceneBundleSchema } from "@/contracts/scene-package";
import { sha256 } from "@/domain/validateGlb";
import { compileSceneRuntime } from "@/domain/runtime/compileSceneRuntime";
import { assembleSceneRuntime } from "@/runtime/assembly/SceneRuntimeAssembler";
import { projectRepository } from "./BrowserProjectRepository";

/** Revalidate the imported package's exact sources; never silently adopt newer files. */
export async function prepareScenePackage(
  scene: ScenePackageInstance,
  mode: "run" | "validation",
  signal: AbortSignal,
) {
  const response = await fetch(
    `/scene/${scene.bundle.id}/.generated/scene.bundle.json`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) throw new Error("场景编译包不可用");
  const raw = await response.arrayBuffer();
  if ((await sha256(raw)) !== scene.bundleHash)
    throw new Error("场景编译包已变化，请重新导入");
  if (
    JSON.stringify(
      sceneBundleSchema.parse(JSON.parse(new TextDecoder().decode(raw))),
    ) !== JSON.stringify(sceneBundleSchema.parse(scene.bundle))
  )
    throw new Error("导入场景与编译包不一致");
  const blob = await projectRepository.getAsset(scene.assetId);
  if (!blob) throw new Error("场景模型缺失，请重新导入");
  const bytes = await blob.arrayBuffer();
  if ((await sha256(bytes)) !== scene.bundle.model_sha256)
    throw new Error("模型哈希变化，请重新导入");
  const sources = await Promise.all(
    Object.entries(scene.bundle.source_hashes).map(async ([path, hash]) => {
      const url = `/scene/${scene.bundle.id}/${path.split("/").map(encodeURIComponent).join("/")}`;
      if (!isSceneUrl(url)) throw new Error("无效源文件路径");
      const response = await fetch(url, { signal, cache: "no-store" });
      if (!response.ok) throw new Error("无法读取 " + path);
      const data = await response.arrayBuffer();
      if ((await sha256(data)) !== hash)
        throw new Error("源文件已变化，请重新编译并导入：" + path);
      return [path, data] as const;
    }),
  );
  signal.throwIfAborted();
  const goal = new Map(sources).get("task-spec.json");
  if (!goal) throw new Error("独立验收目标未纳入输入哈希");
  const compiled = compileSceneRuntime(
    scene.bundle,
    bytes,
    JSON.parse(new TextDecoder().decode(goal)),
    mode,
  );
  signal.throwIfAborted();
  return assembleSceneRuntime(scene.id, crypto.randomUUID(), compiled);
}

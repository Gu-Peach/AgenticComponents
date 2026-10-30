import { catalogIndexSchema, type CatalogEntry } from "@/contracts/catalog";
import { normalizeDeviceSpec } from "@/domain/normalizeDeviceSpec";
import { sha256, validateGlb } from "@/domain/validateGlb";
export async function fetchPublicCatalog() {
  const r = await fetch("/modles/index.json", { cache: "no-store" });
  if (!r.ok) throw new Error("公共模型目录加载失败，请刷新重试");
  return catalogIndexSchema.parse(await r.json()).entries;
}
async function bytes(url: string, expected: string) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`资源读取失败 ${r.status}: ${url}`);
  const b = await r.arrayBuffer();
  if ((await sha256(b)) !== expected) throw new Error(`资源哈希不匹配: ${url}`);
  return b;
}
export async function fetchPublicDefinition(e: CatalogEntry) {
  const d = normalizeDeviceSpec(
    JSON.parse(
      new TextDecoder().decode(await bytes(e.schemaUrl, e.schemaSha256)),
    ),
  );
  if (
    d.specId !== e.specId ||
    d.revision !== e.revision ||
    d.deviceType !== e.deviceType
  )
    throw new Error("目录与设备定义不一致，请重新生成目录");
  const resolved = new URL(
    d.asset.sourceKey ?? "",
    new URL(e.schemaUrl, "https://catalog.invalid"),
  );
  if (
    resolved.pathname !== e.modelUrl ||
    resolved.origin !== "https://catalog.invalid"
  )
    throw new Error("模型路径与目录不一致");
  return {
    ...d,
    asset: { ...d.asset, sourceUrl: e.modelUrl, sha256: e.modelSha256 },
  };
}
export async function fetchPublicModel(e: CatalogEntry) {
  const b = await bytes(e.modelUrl, e.modelSha256);
  validateGlb(b);
  return new Blob([b], { type: "model/gltf-binary" });
}

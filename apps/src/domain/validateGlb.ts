export function validateGlb(bytes: ArrayBuffer) {
  if (bytes.byteLength < 20 || bytes.byteLength > 100 * 1024 * 1024)
    throw new Error("模型需为 100 MB 以内的 GLB 2.0 文件");
  const h = new DataView(bytes),
    length = h.getUint32(12, true);
  if (
    h.getUint32(0, true) !== 0x46546c67 ||
    h.getUint32(4, true) !== 2 ||
    h.getUint32(8, true) !== bytes.byteLength ||
    h.getUint32(16, true) !== 0x4e4f534a ||
    20 + length > bytes.byteLength
  )
    throw new Error("GLB 数据块无效");
  const d = JSON.parse(new TextDecoder().decode(bytes.slice(20, 20 + length)));
  for (const e of [...(d.buffers ?? []), ...(d.images ?? [])])
    if (e.uri && !e.uri.startsWith("data:"))
      throw new Error("请使用资源嵌入式 GLB，不支持外部资源路径");
}
export async function sha256(bytes: ArrayBuffer) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}

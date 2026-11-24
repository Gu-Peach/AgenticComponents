import { Matrix4, Quaternion, Vector3 } from "three";
import { z } from "zod";
const node = z.object({
  name: z.string().optional(),
  mesh: z.number().int().optional(),
  children: z.array(z.number().int()).optional(),
  matrix: z.array(z.number()).length(16).optional(),
  translation: z.array(z.number()).length(3).optional(),
  rotation: z.array(z.number()).length(4).optional(),
  scale: z.array(z.number()).length(3).optional(),
});
const schema = z.object({
  nodes: z.array(node),
  meshes: z.array(
    z.object({
      primitives: z.array(
        z.object({ attributes: z.object({ POSITION: z.number().int() }) }),
      ),
    }),
  ),
  accessors: z.array(
    z.object({
      bufferView: z.number().int(),
      byteOffset: z.number().int().default(0),
      componentType: z.literal(5126),
      count: z.number().int().max(1000000),
      type: z.literal("VEC3").or(z.string()),
      sparse: z.unknown().optional(),
    }),
  ),
  bufferViews: z.array(
    z.object({
      buffer: z.literal(0),
      byteOffset: z.number().int().default(0),
      byteLength: z.number().int(),
      byteStride: z.number().int().optional(),
    }),
  ),
});
/** Only geometry bytes are read; images and scripts are never loaded. */
export class SceneGeometryReader {
  private data: z.infer<typeof schema>;
  private bin: DataView;
  private parents = new Map<number, number>();
  private matrices = new Map<number, Matrix4>();
  constructor(bytes: ArrayBuffer) {
    const view = new DataView(bytes);
    if (
      view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.byteLength
    )
      throw new Error("Invalid GLB");
    const size = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a)
      throw new Error("Missing glTF JSON");
    // Accessors of non-position attributes need not be VEC3/float, so project the POSITION references only below.
    const raw = JSON.parse(
      new TextDecoder().decode(new Uint8Array(bytes, 20, size)),
    );
    const positions = new Set<number>(
      raw.meshes.flatMap(
        (m: { primitives: { attributes: { POSITION: number } }[] }) =>
          m.primitives.map((p) => p.attributes.POSITION),
      ),
    );
    const projected = {
      ...raw,
      accessors: raw.accessors.map((a: Record<string, unknown>, i: number) =>
        positions.has(i)
          ? a
          : { bufferView: 0, componentType: 5126, count: 0, type: "VEC3" },
      ),
    };
    this.data = schema.parse(projected);
    const start = 20 + size;
    if (view.getUint32(start + 4, true) !== 0x004e4942)
      throw new Error("Missing binary chunk");
    this.bin = new DataView(bytes, start + 8, view.getUint32(start, true));
    this.data.nodes.forEach((n, i) =>
      n.children?.forEach((child) => {
        if (
          child < 0 ||
          child >= this.data.nodes.length ||
          this.parents.has(child)
        )
          throw new Error("Invalid GLB hierarchy");
        this.parents.set(child, i);
      }),
    );
  }
  private world(i: number, active = new Set<number>()): Matrix4 {
    const cached = this.matrices.get(i);
    if (cached) return cached;
    if (active.has(i)) throw new Error("Cyclic model");
    active.add(i);
    const n = this.data.nodes[i];
    if (!n) throw new Error("Missing mesh node");
    const local = n.matrix
      ? new Matrix4().fromArray(n.matrix)
      : new Matrix4().compose(
          new Vector3().fromArray(n.translation ?? [0, 0, 0]),
          new Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]),
          new Vector3().fromArray(n.scale ?? [1, 1, 1]),
        );
    const parent = this.parents.get(i);
    const result =
      parent === undefined
        ? local
        : this.world(parent, active).clone().multiply(local);
    active.delete(i);
    this.matrices.set(i, result);
    return result;
  }
  nodePose(index: number) {
    const position = new Vector3(),
      rotation = new Quaternion();
    this.world(index).decompose(position, rotation, new Vector3());
    return { position: position.toArray(), rotation: rotation.toArray() };
  }
  convexParts(
    indices: readonly number[],
    center: readonly number[],
    minimumPoints = 4,
  ): [number, number, number][][] {
    return indices.flatMap((i) => {
      const n = this.data.nodes[i];
      if (n?.mesh === undefined) throw new Error("Owned node is not a mesh");
      const matrix = this.world(i),
        unique = new Map<string, [number, number, number]>();
      for (const primitive of this.data.meshes[n.mesh].primitives) {
        const a = this.data.accessors[primitive.attributes.POSITION];
        if (a.type !== "VEC3" || a.sparse)
          throw new Error("Unsupported position accessor");
        const v = this.data.bufferViews[a.bufferView],
          stride = v.byteStride ?? 12;
        for (let k = 0; k < a.count; k++) {
          const offset = v.byteOffset + a.byteOffset + k * stride;
          if (
            offset + 12 > v.byteOffset + v.byteLength ||
            offset + 12 > this.bin.byteLength
          )
            throw new Error("Position data outside buffer");
          const point = new Vector3(
            this.bin.getFloat32(offset, true),
            this.bin.getFloat32(offset + 4, true),
            this.bin.getFloat32(offset + 8, true),
          )
            .applyMatrix4(matrix)
            .sub(new Vector3(...center));
          const tuple = point.toArray();
          if (!tuple.every(Number.isFinite))
            throw new Error("Nonfinite mesh point");
          unique.set(tuple.map((x) => x.toFixed(7)).join(","), tuple);
        }
      }
      const points = [...unique.values()];
      return points.length >= minimumPoints ? [points] : [];
    });
  }
}

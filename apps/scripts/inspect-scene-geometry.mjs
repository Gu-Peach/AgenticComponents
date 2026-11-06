import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Matrix4, Vector3, Quaternion, Box3, PropertyBinding } from "three";

const args = process.argv.slice(2);
if (args.length !== 2)
  throw new Error(
    "Usage: node scripts/inspect-scene-geometry.mjs <model.glb> <output.json>",
  );
const bytes = await readFile(args[0]);
if (
  bytes.length < 20 ||
  bytes.toString("ascii", 0, 4) !== "glTF" ||
  bytes.readUInt32LE(4) !== 2 ||
  bytes.readUInt32LE(8) !== bytes.length ||
  bytes.readUInt32LE(16) !== 0x4e4f534a
)
  throw new Error("Invalid GLB 2.0");
const length = bytes.readUInt32LE(12);
if (length > bytes.length - 20) throw new Error("Invalid JSON chunk length");
const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString("utf8"));
const nodes = gltf.nodes ?? [],
  parents = new Map();
nodes.forEach((node, index) =>
  (node.children ?? []).forEach((child) => {
    if (
      !Number.isInteger(child) ||
      child < 0 ||
      child >= nodes.length ||
      parents.has(child)
    )
      throw new Error("Invalid scene tree");
    parents.set(child, index);
  }),
);
const cache = new Map(),
  active = new Set(),
  bounds = new Map();
function world(index) {
  if (cache.has(index)) return cache.get(index);
  if (active.has(index)) throw new Error("Cyclic scene tree");
  active.add(index);
  const node = nodes[index];
  const matrix = node.matrix
    ? new Matrix4().fromArray(node.matrix)
    : new Matrix4().compose(
        new Vector3(...(node.translation ?? [0, 0, 0])),
        new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
        new Vector3(...(node.scale ?? [1, 1, 1])),
      );
  if (parents.has(index)) matrix.premultiply(world(parents.get(index)));
  active.delete(index);
  cache.set(index, matrix);
  return matrix;
}
function envelope(index) {
  if (bounds.has(index)) return bounds.get(index);
  world(index);
  const node = nodes[index],
    box = new Box3();
  if (node.mesh !== undefined)
    for (const primitive of gltf.meshes[node.mesh].primitives) {
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      if (!accessor.min || !accessor.max)
        throw new Error("Position bounds are not declared");
      box.union(
        new Box3(
          new Vector3(...accessor.min),
          new Vector3(...accessor.max),
        ).applyMatrix4(world(index)),
      );
    }
  for (const child of node.children ?? []) box.union(envelope(child));
  bounds.set(index, box);
  return box;
}
function path(index) {
  return [
    ...(parents.has(index) ? path(parents.get(index)) : []),
    { index, name: nodes[index].name ?? "" },
  ];
}
const report = nodes.map((node, index) => {
  const box = envelope(index);
  return {
    index,
    name: node.name ?? "",
    three_name: PropertyBinding.sanitizeNodeName(node.name ?? ""),
    parent: parents.get(index) ?? null,
    path: path(index),
    local_transform: {
      translation: node.translation ?? [0, 0, 0],
      rotation: node.rotation ?? [0, 0, 0, 1],
      scale: node.scale ?? [1, 1, 1],
      matrix: node.matrix ?? null,
    },
    world_matrix: world(index).toArray(),
    world_position: new Vector3().setFromMatrixPosition(world(index)).toArray(),
    bounds: box.isEmpty()
      ? null
      : {
          min: box.min.toArray(),
          max: box.max.toArray(),
          size: box.getSize(new Vector3()).toArray(),
        },
    children: node.children ?? [],
    mesh: node.mesh ?? null,
  };
});
await writeFile(
  args[1],
  JSON.stringify(
    {
      schema_version: "scene-node-geometry/0.1",
      model_sha256: createHash("sha256").update(bytes).digest("hex"),
      bounds_caveat:
        "mesh envelopes in composed GLB scene coordinates; not collision or actuator calibration",
      nodes: report,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Inspected ${nodes.length} nodes without modifying GLB bytes.`);

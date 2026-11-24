/** 从关联的 GLB 静止几何测量底面中心，装配后在设备局部坐标中复用同一接口。 */
import { Box3, Matrix4, Quaternion, Vector3 } from "three";
import type { DeviceDefinition } from "@/contracts/device";
import type { SpatialInterface } from "@/contracts/spatial";
import { matrixOf, identityTransform } from "./transforms";

interface GlbNode {
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  mesh?: number;
  children?: number[];
}
interface GlbLayout {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GlbNode[];
  meshes?: { primitives: { attributes: { POSITION?: number } }[] }[];
  accessors?: { min?: number[]; max?: number[] }[];
}
const basePort = (): SpatialInterface => ({
  interface_id: "mount_base",
  name: "设备底部安装面",
  local_frame_pending: true,
  capabilities: { snap: { role: "mount_base", accepts: ["carriage_mount"] } },
});

export function withModelMount(
  def: DeviceDefinition,
  bytes: ArrayBuffer,
): DeviceDefinition {
  const data = new DataView(bytes);
  const glb: GlbLayout = JSON.parse(
    new TextDecoder().decode(
      new Uint8Array(bytes, 20, data.getUint32(12, true)),
    ),
  );
  const nodes = glb.nodes ?? [];
  const bounds = new Box3(),
    visited = new Set<number>();
  let complete = true;
  function visit(id: number, parent: Matrix4) {
    const n = nodes[id];
    if (!n || visited.has(id))
      throw new Error("Invalid GLB installation hierarchy");
    visited.add(id);
    const local = n.matrix
      ? new Matrix4().fromArray(n.matrix)
      : new Matrix4().compose(
          new Vector3().fromArray(n.translation ?? [0, 0, 0]),
          new Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]),
          new Vector3().fromArray(n.scale ?? [1, 1, 1]),
        );
    const world = parent.clone().multiply(local);
    if (n.mesh !== undefined)
      for (const p of glb.meshes?.[n.mesh]?.primitives ?? []) {
        const idx = p.attributes.POSITION;
        const a = idx === undefined ? undefined : glb.accessors?.[idx];
        if (
          a?.min?.length !== 3 ||
          a.max?.length !== 3 ||
          ![...a.min, ...a.max].every(Number.isFinite)
        ) {
          complete = false;
          continue;
        }
        bounds.union(
          new Box3(
            new Vector3().fromArray(a.min),
            new Vector3().fromArray(a.max),
          ).applyMatrix4(world),
        );
      }
    for (const child of n.children ?? []) visit(child, world);
  }
  const transform = matrixOf(def.asset.importTransform ?? identityTransform);
  for (const root of glb.scenes?.[glb.scene ?? 0]?.nodes ?? [])
    visit(root, transform);
  const port = basePort();
  if (complete && !bounds.isEmpty() && transform.determinant() > 0) {
    const center = bounds.getCenter(new Vector3());
    center.y = bounds.min.y;
    const inverse = transform.clone().invert();
    delete port.local_frame_pending;
    port.local_frame = {
      position: center.applyMatrix4(inverse).toArray(),
      forward: new Vector3(0, -1, 0).transformDirection(inverse).toArray(),
      up: new Vector3(0, 0, 1).transformDirection(inverse).toArray(),
    };
  }
  return {
    ...def,
    spatialInterfaces: [
      ...(def.spatialInterfaces ?? []).filter(
        (p) => p.interface_id !== port.interface_id,
      ),
      port,
    ],
  };
}

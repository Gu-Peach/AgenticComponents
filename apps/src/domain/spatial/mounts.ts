/** 从兼容空间接口解析永久挂载关系，按实际端点角色判定父子方向。 */
import { Matrix4, Vector3 } from "three";
import { identityTransform, matrixOf, uniformScale } from "./transforms";

import type { SpatialConnection, ProjectDocument } from "@/contracts/device";
import type { SpatialInterface } from "@/contracts/spatial";

const isMountRole = (role: string) =>
  role === "carriage_mount" || role === "mount_base";

export function mountParents(
  connections: readonly SpatialConnection[],
  portAt: (endpoint: SpatialConnection["a"]) => SpatialInterface | undefined,
) {
  const parents = new Map<string, SpatialConnection["a"]>();
  const occupied = new Set<string>();
  const ids = new Set<string>();
  for (const link of connections) {
    if (ids.has(link.id))
      throw new Error("Duplicate connection ID: " + link.id);
    ids.add(link.id);
    const a = portAt(link.a),
      b = portAt(link.b);
    if (!a || !b) throw new Error("Unknown connection endpoint: " + link.id);
    const ar = a.capabilities.snap,
      br = b.capabilities.snap;
    if (!isMountRole(ar.role) && !isMountRole(br.role)) continue;
    if (
      !ar.accepts.includes(br.role) ||
      !br.accepts.includes(ar.role) ||
      ![ar.role, br.role].includes("mount_base") ||
      ![ar.role, br.role].includes("carriage_mount")
    )
      throw new Error("Incompatible mount ports: " + link.id);
    if (!a.local_frame || !b.local_frame)
      throw new Error("Uncalibrated mount: " + link.id);
    const [parent, child] =
      ar.role === "carriage_mount" ? [link.a, link.b] : [link.b, link.a];
    const endpoint = JSON.stringify([parent.instanceId, parent.interfaceId]);
    if (occupied.has(endpoint) || parents.has(child.instanceId))
      throw new Error("Mount already occupied: " + link.id);
    occupied.add(endpoint);
    parents.set(child.instanceId, parent);
  }
  for (const child of parents.keys()) {
    let next: string | undefined = child;
    const path = new Set<string>();
    while (next !== undefined) {
      if (path.has(next)) throw new Error("Cyclic mount: " + next);
      path.add(next);
      next = parents.get(next)?.instanceId;
    }
  }
  return parents;
}

type Frame = NonNullable<SpatialInterface["local_frame"]>;
export function alignedMountFrames(
  a: Frame,
  am: Matrix4,
  b: Frame,
  bm: Matrix4,
) {
  const point = (f: Frame, m: Matrix4) =>
    new Vector3(...f.position).applyMatrix4(m);
  const direction = (v: Frame["up"], m: Matrix4) =>
    new Vector3(...v).transformDirection(m);
  return (
    point(a, am).distanceTo(point(b, bm)) <= 0.005 &&
    direction(a.forward, am).dot(direction(b.forward, bm)) < -0.999 &&
    direction(a.up, am).dot(direction(b.up, bm)) > 0.999
  );
}

export function projectMountParents(project: ProjectDocument) {
  const instances = new Map(project.instances.map((i) => [i.instanceId, i]));
  const definitions = new Map(project.definitions.map((d) => [d.specId, d]));
  const portAt = (end: SpatialConnection["a"]) => {
    const instance = instances.get(end.instanceId);
    return (
      instance &&
      definitions
        .get(instance.specId)
        ?.spatialInterfaces?.find((p) => p.interface_id === end.interfaceId)
    );
  };
  const parents = mountParents(project.connections ?? [], portAt);
  const matrix = (id: string) => {
    const instance = instances.get(id)!;
    const imported =
      definitions.get(instance.specId)!.asset.importTransform ??
      identityTransform;
    if (!uniformScale(instance.transform) || !uniformScale(imported))
      throw new Error("Unsupported mount scale: " + id);
    return matrixOf(instance.transform).multiply(matrixOf(imported));
  };
  for (const link of project.connections ?? []) {
    const a = portAt(link.a)!,
      b = portAt(link.b)!;
    if (
      a.capabilities.snap.role !== "carriage_mount" &&
      b.capabilities.snap.role !== "carriage_mount"
    )
      continue;
    if (
      !alignedMountFrames(
        a.local_frame!,
        matrix(link.a.instanceId),
        b.local_frame!,
        matrix(link.b.instanceId),
      )
    )
      throw new Error("Installed mount frames are not aligned: " + link.id);
  }
  return parents;
}

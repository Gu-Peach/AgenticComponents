import { Euler, Quaternion, Vector3 } from "three";
import type {
  DeviceDefinition,
  DeviceInstance,
  ProjectDocument,
  Transform,
  Vec3,
} from "@/contracts/device";
import { resolveInterfaceFrame } from "@/domain/resolveInterfaceFrame";
import { resolveParameters } from "@/validation/contracts";
import {
  frameRotation,
  identityTransform,
  matrixOf,
  uniformScale,
} from "./transforms";
export const SNAP_DISTANCE = 0.15;
export const SNAP_ANGLE = Math.PI / 6;
export interface SnapCandidate {
  sourceInterface: string;
  targetInstance: string;
  targetInterface: string;
  transform: Transform;
  position: Vec3;
  distance: number;
}
export function interfaceWorld(
  instance: DeviceInstance,
  def: DeviceDefinition,
  id: string,
) {
  const port = def.spatialInterfaces?.find((p) => p.interface_id === id);
  if (!port) return null;
  let f;
  try {
    f = resolveInterfaceFrame(
      port,
      def,
      resolveParameters(def, instance.paramOverrides),
    );
  } catch {
    return null;
  }
  if (!f) return null;
  const matrix = matrixOf(instance.transform).multiply(
    matrixOf(def.asset.importTransform ?? identityTransform),
  );
  const rotation = new Quaternion()
    .setFromEuler(new Euler(...instance.transform.rotation))
    .multiply(
      new Quaternion().setFromEuler(
        new Euler(...(def.asset.importTransform ?? identityTransform).rotation),
      ),
    )
    .multiply(frameRotation(f.forward, f.up));
  return {
    position: new Vector3(...f.position).applyMatrix4(matrix),
    rotation,
    frame: f,
    port,
  };
}
export function findSnap(
  project: ProjectDocument,
  moving: DeviceInstance,
): SnapCandidate | null {
  const def = project.definitions.find((d) => d.specId === moving.specId);
  if (
    !def ||
    !uniformScale(moving.transform) ||
    !uniformScale(def.asset.importTransform ?? identityTransform)
  )
    return null;
  const candidates: SnapCandidate[] = [];
  for (const target of project.instances) {
    if (
      target.instanceId === moving.instanceId ||
      !target.visible ||
      !uniformScale(target.transform)
    )
      continue;
    const other = project.definitions.find((d) => d.specId === target.specId);
    if (
      !other ||
      !uniformScale(other.asset.importTransform ?? identityTransform)
    )
      continue;
    for (const a of def.spatialInterfaces ?? [])
      for (const b of other.spatialInterfaces ?? []) {
        if (
          !a.capabilities.snap.accepts.includes(b.capabilities.snap.role) ||
          !b.capabilities.snap.accepts.includes(a.capabilities.snap.role)
        )
          continue;
        if (
          project.connections?.some(
            (c) =>
              c.a.instanceId !== moving.instanceId &&
              c.b.instanceId !== moving.instanceId &&
              ((c.a.instanceId === target.instanceId &&
                c.a.interfaceId === b.interface_id) ||
                (c.b.instanceId === target.instanceId &&
                  c.b.interfaceId === b.interface_id)),
          )
        )
          continue;
        const source = interfaceWorld(moving, def, a.interface_id),
          destination = interfaceWorld(target, other, b.interface_id);
        if (!source || !destination) continue;
        const distance = source.position.distanceTo(destination.position);
        if (distance > SNAP_DISTANCE) continue;
        const desired = destination.rotation
          .clone()
          .multiply(
            new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI),
          );
        if (source.rotation.angleTo(desired) > SNAP_ANGLE) continue;
        const asset = def.asset.importTransform ?? identityTransform;
        const localRotation = new Quaternion()
          .setFromEuler(new Euler(...asset.rotation))
          .multiply(frameRotation(source.frame.forward, source.frame.up));
        const rootRotation = desired.multiply(localRotation.invert());
        const localPoint = new Vector3(...source.frame.position)
          .applyMatrix4(matrixOf(asset))
          .multiply(new Vector3(...moving.transform.scale))
          .applyQuaternion(rootRotation);
        const position = destination.position.clone().sub(localPoint);
        const transform: Transform = {
          position: position.toArray() as Vec3,
          rotation: new Euler()
            .setFromQuaternion(rootRotation)
            .toArray()
            .slice(0, 3) as Vec3,
          scale: [...moving.transform.scale],
        };
        candidates.push({
          sourceInterface: a.interface_id,
          targetInstance: target.instanceId,
          targetInterface: b.interface_id,
          transform,
          position: destination.position.toArray() as Vec3,
          distance,
        });
      }
  }
  candidates.sort(
    (a, b) =>
      a.distance - b.distance ||
      `${a.targetInstance}/${a.targetInterface}/${a.sourceInterface}`.localeCompare(
        `${b.targetInstance}/${b.targetInterface}/${b.sourceInterface}`,
      ),
  );
  return candidates[0] ?? null;
}

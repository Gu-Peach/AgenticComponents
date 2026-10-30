import { Matrix4, Quaternion, Euler, Vector3 } from "three";
import type { Transform, Vec3 } from "@/contracts/device";
export const identityTransform: Transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};
export function matrixOf(t: Transform) {
  return new Matrix4().compose(
    new Vector3(...t.position),
    new Quaternion().setFromEuler(new Euler(...t.rotation)),
    new Vector3(...t.scale),
  );
}
export function frameRotation(forward: Vec3, up: Vec3) {
  const z = new Vector3(...forward).normalize(),
    y = new Vector3(...up).normalize(),
    x = new Vector3().crossVectors(y, z).normalize();
  y.crossVectors(z, x).normalize();
  return new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(x, y, z),
  );
}
export function uniformScale(t: Transform) {
  return t.scale.every(
    (n) => n > 0 && Number.isFinite(n) && Math.abs(n - t.scale[0]) < 1e-6,
  );
}

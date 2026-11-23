import { Vector3 } from "three";
import type {
  WarehouseAssembly,
  WarehouseLocation,
} from "@/contracts/warehouse";
/** Both axes refer to the same platform anchor, never to a guessed world X/Y. */
export function resolveDock(
  assembly: WarehouseAssembly,
  location: WarehouseLocation,
) {
  const delta = new Vector3(...location.position).sub(
    new Vector3(...assembly.anchor),
  );
  const a = new Vector3(...assembly.axis),
    b = new Vector3(...assembly.vertical);
  if (
    Math.abs(a.length() - 1) > 1e-6 ||
    Math.abs(b.length() - 1) > 1e-6 ||
    Math.abs(a.dot(b)) > 1e-6
  )
    throw new Error("Dock axes must be orthonormal");
  const rail = delta.dot(a),
    lift = delta.dot(b);
  const gap = delta
    .addScaledVector(a, -rail)
    .addScaledVector(b, -lift)
    .length();
  if (
    rail < assembly.railLimits[0] ||
    rail > assembly.railLimits[1] ||
    lift < assembly.liftLimits[0] ||
    lift > assembly.liftLimits[1] ||
    gap > assembly.maxTransfer
  )
    throw new Error("Dock target is unreachable");
  return Object.freeze({ target: location.id, rail, lift, gap });
}

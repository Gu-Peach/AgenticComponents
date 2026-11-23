import { Quaternion, Vector3 } from "three";
import type { BodyPose, RuntimeBody } from "@/contracts/physics";
import type { Vec3 } from "@/contracts/device";
/** Conservative swept load AABB against each convex part, preserving physical contacts at endpoints. */
export function sweptLoadBlocker(
  from: Vec3,
  to: Vec3,
  size: Vec3,
  bodies: readonly RuntimeBody[],
  poses: Readonly<Record<string, { active: boolean; pose?: BodyPose }>>,
  ignore: ReadonlySet<string>,
): string | undefined {
  for (const body of bodies) {
    const state = poses[body.id];
    if (ignore.has(body.id) || body.sensor || !state?.active || !state.pose)
      continue;
    const pose = state.pose,
      q = new Quaternion(...pose.rotation);
    const parts = body.convexParts ?? [
      [-1, 1].flatMap((x) =>
        [-1, 1].flatMap((y) =>
          [-1, 1].map(
            (z) =>
              [
                (x * body.size[0]) / 2,
                (y * body.size[1]) / 2,
                (z * body.size[2]) / 2,
              ] as Vec3,
          ),
        ),
      ),
    ];
    for (const part of parts) {
      const points = part.map((p) =>
        new Vector3(...p)
          .applyQuaternion(q)
          .add(new Vector3(...pose.position))
          .toArray(),
      );
      const lo = [0, 1, 2].map(
          (i) => Math.min(...points.map((p) => p[i])) - size[i] / 2 + 0.003,
        ),
        hi = [0, 1, 2].map(
          (i) => Math.max(...points.map((p) => p[i])) + size[i] / 2 - 0.003,
        );
      let enter = 0,
        exit = 1;
      for (let i = 0; i < 3; i++) {
        const delta = to[i] - from[i];
        if (Math.abs(delta) < 1e-10) {
          if (from[i] <= lo[i] || from[i] >= hi[i]) {
            enter = 2;
            break;
          }
        } else {
          const a = (lo[i] - from[i]) / delta,
            b = (hi[i] - from[i]) / delta;
          enter = Math.max(enter, Math.min(a, b));
          exit = Math.min(exit, Math.max(a, b));
        }
      }
      if (enter <= exit && enter <= 1 && exit >= 0) return body.id;
    }
  }
}

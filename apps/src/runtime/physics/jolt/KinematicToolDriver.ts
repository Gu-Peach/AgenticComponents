import type initJolt from "jolt-physics";
import type Jolt from "jolt-physics";
import type { BodyPose } from "@/contracts/physics";
export function moveTool(
  J: Awaited<ReturnType<typeof initJolt>>,
  bi: Jolt.BodyInterface,
  body: Jolt.Body,
  pose: BodyPose,
  dt: number,
) {
  if (
    !Number.isFinite(dt) ||
    dt <= 0 ||
    [...pose.position, ...pose.rotation].some((n) => !Number.isFinite(n)) ||
    Math.abs(Math.hypot(...pose.rotation) - 1) > 1e-5
  )
    throw new Error("运动学工具目标无效");
  const p = new J.RVec3(...pose.position),
    q = new J.Quat(...pose.rotation);
  try {
    bi.MoveKinematic(body.GetID(), p, q, dt);
  } finally {
    J.destroy(p);
    J.destroy(q);
  }
}

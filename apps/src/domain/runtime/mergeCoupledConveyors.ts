import type {
  PhysicsConfig,
  RuntimeBody,
  RuntimeSurface,
} from "@/contracts/physics";
/** Coplanar, abutting, identically driven box supports form one seam-free collision plane. */
export function mergeCoupledConveyors(
  config: PhysicsConfig,
  surfaceIds: readonly string[],
  groupId: string,
  joinTolerance = 1e-6,
): PhysicsConfig {
  if (
    !Number.isFinite(joinTolerance) ||
    joinTolerance < 0 ||
    joinTolerance > 1e-4
  )
    throw new Error("Invalid contact-proxy join tolerance");
  if (surfaceIds.length < 2 || new Set(surfaceIds).size !== surfaceIds.length)
    throw new Error("Invalid coupled surfaces");
  const surfaces = surfaceIds.map((id) => {
    const s = config.surfaces?.find((s) => s.id === id);
    if (!s) throw new Error("Missing coupled surface");
    return s;
  });
  const bodies = surfaces.map((s) => {
    const b = config.bodies?.find((b) => b.id === s.bodyId);
    if (!b) throw new Error("Missing support body");
    return b;
  });
  const first = bodies[0],
    flow = surfaces[0].direction;
  const along = Math.abs(flow[0]) > Math.abs(flow[2]) ? 0 : 2;
  const across = along === 0 ? 2 : 0;
  if (
    Math.abs(Math.abs(flow[along]) - 1) > 1e-6 ||
    Math.abs(flow[1]) + Math.abs(flow[across]) > 1e-6
  )
    throw new Error("Merged support requires horizontal X/Z-aligned flow");
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i],
      s = surfaces[i];
    if (
      b.motionType !== "static" ||
      b.role !== "conveying_support" ||
      b.rotation.some((v, j) => Math.abs(v - [0, 0, 0, 1][j]) > 1e-6) ||
      s.direction.some((v, j) => Math.abs(v - flow[j]) > 1e-6) ||
      s.normal.some((v, j) => Math.abs(v - [0, 1, 0][j]) > 1e-6) ||
      Math.abs(
        b.position[1] + b.size[1] / 2 - first.position[1] - first.size[1] / 2,
      ) > 1e-6 ||
      Math.abs(b.position[across] - first.position[across]) > 1e-6 ||
      Math.abs(b.size[across] - first.size[across]) > 1e-6 ||
      b.friction !== first.friction ||
      b.restitution !== first.restitution
    )
      throw new Error("Coupled collision surfaces are not compatible/coplanar");
  }
  const spans = bodies
    .map((b) => [
      b.position[along] - b.size[along] / 2,
      b.position[along] + b.size[along] / 2,
    ])
    .sort((a, b) => a[0] - b[0]);
  let end = spans[0][1];
  for (const [start, next] of spans.slice(1)) {
    if (start > end + joinTolerance)
      throw new Error("Physical gap cannot be bridged by the coupled proxy");
    end = Math.max(end, next);
  }
  if (
    config.bodies?.some((b) => b.id === groupId) ||
    config.surfaces?.some((s) => s.id === groupId + "/surface")
  )
    throw new Error("Group identity collision");
  const body: RuntimeBody = {
    ...first,
    id: groupId,
    instanceId: groupId,
    position: [...first.position],
    size: [...first.size],
  };
  body.position[along] = (spans[0][0] + end) / 2;
  body.size[along] = end - spans[0][0];
  const surface: RuntimeSurface = {
    id: groupId + "/surface",
    bodyId: groupId,
    direction: flow,
    normal: [0, 1, 0],
    aliases: [...surfaceIds],
  };
  return {
    ...config,
    bodies: [
      ...config.bodies!.filter((b) => !bodies.some((old) => old.id === b.id)),
      body,
    ],
    surfaces: [
      ...config.surfaces!.filter((s) => !surfaceIds.includes(s.id)),
      surface,
    ],
  };
}

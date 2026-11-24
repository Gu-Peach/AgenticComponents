/** 由场景决定供料时机，出料站为已登记身份按批激活刚体并确认供料支承。 */
import type { BodyPose, PhysicsPort, RuntimeBody } from "@/contracts/physics";
export class MaterialSupply {
  private readonly admitted = new Set<string>();
  constructor(private physics: PhysicsPort) {}
  present(placements: readonly { id: string; pose: BodyPose }[]) {
    if (
      !placements.length ||
      new Set(placements.map((p) => p.id)).size !== placements.length
    )
      throw new Error("Invalid source batch identities");
    const known = placements.filter((p) => this.admitted.has(p.id)).length;
    if (known === placements.length) return;
    if (known) throw new Error("Partial source batch was already admitted");
    const active = placements.filter((p) =>
      this.physics.isBodyActive!(p.id),
    ).length;
    if (active && active !== placements.length)
      throw new Error("Partial load already exists");
    if (!active) this.physics.activateBodies!(placements);
    for (const p of placements) this.admitted.add(p.id);
  }
  presentAtRest(bodies: readonly RuntimeBody[]) {
    this.present(
      bodies.map((b) => ({
        id: b.id,
        pose: {
          position: b.position,
          rotation: b.rotation,
          velocity: [0, 0, 0],
        },
      })),
    );
  }
  settledOn(
    body: string,
    support: string,
    speed: number,
    angularSpeed: number,
  ) {
    if (
      !this.physics.isBodyActive!(body) ||
      !this.physics.hasContactSupport!(body, support)
    )
      return false;
    const pose = this.physics.readBody!(body);
    return (
      Math.hypot(...pose.velocity) <= speed &&
      Math.hypot(...(pose.angularVelocity ?? [])) <= angularSpeed
    );
  }
}

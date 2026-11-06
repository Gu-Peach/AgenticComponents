import type initJolt from "jolt-physics";
import type Jolt from "jolt-physics";
import type { RuntimeSurface } from "@/contracts/physics";
import { BodyRegistry } from "./BodyRegistry";
type Module = Awaited<ReturnType<typeof initJolt>>;
export class ConveyorContacts {
  readonly listener: Jolt.ContactListenerJS;
  private velocity: Jolt.Vec3;
  private contacts = new Map<string, { body: string; surface: string }>();
  private surfaces = new Map<string, RuntimeSurface>();
  private speeds = new Map<string, number>();
  private aliases = new Map<string, string>();
  constructor(
    private J: Module,
    private bodies: BodyRegistry,
    surfaces: RuntimeSurface[],
  ) {
    for (const s of surfaces) {
      if (this.speeds.has(s.id) || this.surfaces.has(s.bodyId))
        throw new Error("Duplicate surface");
      bodies.get(s.bodyId);
      this.surfaces.set(s.bodyId, s);
      this.speeds.set(s.id, 0);
      for (const alias of [s.id, ...(s.aliases ?? [])]) {
        if (this.aliases.has(alias)) throw new Error("Duplicate surface alias");
        this.aliases.set(alias, s.id);
      }
    }
    this.velocity = new J.Vec3(0, 0, 0);
    const listener = new J.ContactListenerJS();
    listener.OnContactValidate = () =>
      J.ValidateResult_AcceptAllContactsForThisBodyPair;
    const contact = (
      aPtr: number,
      bPtr: number,
      mPtr: number,
      sPtr: number,
    ) => {
      const a = J.wrapPointer(aPtr, J.Body),
        b = J.wrapPointer(bPtr, J.Body),
        ka = a.GetID().GetIndexAndSequenceNumber(),
        kb = b.GetID().GetIndexAndSequenceNumber(),
        ra = bodies.fromKey(ka),
        rb = bodies.fromKey(kb);
      if (!ra || !rb) return;
      const sa = this.surfaces.get(ra.definition.id),
        sb = this.surfaces.get(rb.definition.id);
      const first = Boolean(
        sa &&
        rb.definition.motionType === "dynamic" &&
        ["material", "carrier"].includes(rb.definition.role),
      );
      const surface = first ? sa : sb;
      const manifold = J.wrapPointer(mPtr, J.ContactManifold),
        n = manifold.mWorldSpaceNormal;
      if (!surface) {
        const isLoad = (r: typeof ra) =>
          r.definition.motionType === "dynamic" &&
          ["material", "carrier"].includes(r.definition.role);
        const isSupport = (r: typeof ra) =>
          ["carrier", "support", "conveying_support"].includes(
            r.definition.role,
          );
        if (isLoad(rb) && isSupport(ra) && n.GetY() > 0.8)
          this.contacts.set(
            this.key(
              ka,
              kb,
              manifold.mSubShapeID1.GetValue(),
              manifold.mSubShapeID2.GetValue(),
            ),
            { body: rb.definition.id, surface: ra.definition.id },
          );
        else if (isLoad(ra) && isSupport(rb) && n.GetY() < -0.8)
          this.contacts.set(
            this.key(
              ka,
              kb,
              manifold.mSubShapeID1.GetValue(),
              manifold.mSubShapeID2.GetValue(),
            ),
            { body: ra.definition.id, surface: rb.definition.id },
          );
        return;
      }
      if (
        !first &&
        (ra.definition.motionType !== "dynamic" ||
          !["material", "carrier"].includes(ra.definition.role))
      )
        return;
      const sign = first ? 1 : -1;
      const dot =
        sign *
        (n.GetX() * surface.normal[0] +
          n.GetY() * surface.normal[1] +
          n.GetZ() * surface.normal[2]);
      if (dot < 0.8) return;
      this.contacts.set(
        this.key(
          ka,
          kb,
          manifold.mSubShapeID1.GetValue(),
          manifold.mSubShapeID2.GetValue(),
        ),
        { body: (first ? rb : ra).definition.id, surface: surface.id },
      );
      this.velocity.Set(
        ...(surface.direction.map(
          (v) => -sign * this.speeds.get(surface.id)! * v,
        ) as [number, number, number]),
      );
      J.wrapPointer(sPtr, J.ContactSettings).mRelativeLinearSurfaceVelocity =
        this.velocity;
    };
    listener.OnContactAdded = contact;
    listener.OnContactPersisted = contact;
    listener.OnContactRemoved = (ptr) => {
      const p = J.wrapPointer(ptr, J.SubShapeIDPair);
      this.contacts.delete(
        this.key(
          p.GetBody1ID().GetIndexAndSequenceNumber(),
          p.GetBody2ID().GetIndexAndSequenceNumber(),
          p.GetSubShapeID1().GetValue(),
          p.GetSubShapeID2().GetValue(),
        ),
      );
    };
    this.listener = listener;
  }
  private key(a: number, b: number, sa: number, sb: number) {
    return a < b ? `${a}/${sa}:${b}/${sb}` : `${b}/${sb}:${a}/${sa}`;
  }
  beginSubstep() {
    this.contacts.clear();
  }
  setSpeed(speed: number) {
    if (this.speeds.size !== 1)
      throw new Error("Use explicit surface IDs in a multi-surface world");
    this.setSpeeds({ [[...this.speeds.keys()][0]]: speed });
  }
  setSpeeds(speeds: Readonly<Record<string, number>>) {
    const canonical = new Map<string, number>();
    for (const [id, speed] of Object.entries(speeds)) {
      const target = this.aliases.get(id);
      if (!target || !Number.isFinite(speed))
        throw new Error("Invalid surface speed batch");
      if (canonical.has(target) && canonical.get(target) !== speed)
        throw new Error("Coupled surface speeds disagree");
      canonical.set(target, speed);
    }
    for (const [id, speed] of canonical) this.speeds.set(id, speed);
  }
  getSpeed(id: string) {
    const value = this.speeds.get(this.aliases.get(id) ?? id);
    if (value === undefined) throw new Error("Unknown surface");
    return value;
  }
  hasSupport(body: string, surface?: string) {
    return [...this.contacts.values()].some(
      (c) =>
        c.body === body &&
        (!surface || c.surface === (this.aliases.get(surface) ?? surface)),
    );
  }
  dispose() {
    this.contacts.clear();
    this.J.destroy(this.listener);
    this.J.destroy(this.velocity);
  }
}

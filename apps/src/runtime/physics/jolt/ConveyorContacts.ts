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
  private speed = 0;
  constructor(
    private J: Module,
    private bodies: BodyRegistry,
    surfaces: RuntimeSurface[],
  ) {
    for (const s of surfaces) {
      bodies.get(s.bodyId);
      this.surfaces.set(s.bodyId, s);
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
        rb.definition.role === "material",
      );
      const surface = first ? sa : sb;
      if (
        !surface ||
        (!first &&
          (ra.definition.motionType !== "dynamic" ||
            ra.definition.role !== "material"))
      )
        return;
      const manifold = J.wrapPointer(mPtr, J.ContactManifold),
        n = manifold.mWorldSpaceNormal,
        sign = first ? 1 : -1;
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
        ...(surface.direction.map((v) => -sign * this.speed * v) as [
          number,
          number,
          number,
        ]),
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
    this.speed = speed;
  }
  hasSupport(body: string, surface?: string) {
    return [...this.contacts.values()].some(
      (c) => c.body === body && (!surface || c.surface === surface),
    );
  }
  dispose() {
    this.contacts.clear();
    this.J.destroy(this.listener);
    this.J.destroy(this.velocity);
  }
}

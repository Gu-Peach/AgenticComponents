/** 管理有限批次中托盘和物料的入场与离场，根据实际身份、支承和位置确认供料、物料交付及空盘移出。 */

import { getDeviceModule } from "@/devices/registry";
import { Quaternion, Vector3 } from "three";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
export interface EnvironmentBody {
  id: string;
  bodyId: string;
  initial: BodyPose;
  size: [number, number, number];
}
export interface CarrierLoad {
  carrier: EnvironmentBody;
  items: EnvironmentBody[];
  sourceSupport: string;
}
export interface HandoffTarget {
  position: [number, number, number];
  referenceOffset: [number, number, number];
  supportId: string;
  tolerance: number;
  speedTolerance: number;
}
export interface EnvironmentReceipt {
  sequence: number;
  runId: string;
  tick: number;
  kind:
    | "supply_requested"
    | "supply_confirmed"
    | "material_delivered"
    | "carrier_departed";
  subjectId: string;
  bodyIds: string[];
  position: [number, number, number];
}
/** A finite batch reports each physical lifecycle event once, in its original run. */
export class BatchReceipts {
  private readonly entries: EnvironmentReceipt[] = [];
  private readonly seen = new Map<EnvironmentReceipt["kind"], Set<string>>();
  constructor(private runId: string) {}
  has(kind: EnvironmentReceipt["kind"], id: string) {
    return this.seen.get(kind)?.has(id) ?? false;
  }
  record(
    kind: EnvironmentReceipt["kind"],
    id: string,
    bodyIds: string[],
    tick: number,
    position: EnvironmentReceipt["position"],
  ) {
    if (this.has(kind, id)) return;
    if (!Number.isSafeInteger(tick) || tick < (this.entries.at(-1)?.tick ?? 0))
      throw new Error("Invalid batch receipt tick");
    let subjects = this.seen.get(kind);
    if (!subjects) this.seen.set(kind, (subjects = new Set()));
    subjects.add(id);
    this.entries.push({
      sequence: this.entries.length + 1,
      runId: this.runId,
      tick,
      kind,
      subjectId: id,
      bodyIds: [...bodyIds],
      position: [...position],
    });
  }
  snapshot() {
    return structuredClone(this.entries);
  }
  /** Entries are immutable after append. The observation publisher copies each frame. */
  current() {
    return [...this.entries];
  }
}
/** Operates finite preallocated bodies; only actual contact/identity checks produce receipts. */
export class FiniteBatchLifecycle {
  private admitted = new Set<string>();
  private confirmed = new Set<string>();
  private delivered = new Set<string>();
  private departed = new Set<string>();
  private receipts: BatchReceipts;
  private lastTick = 0;
  private readonly supply;
  constructor(
    readonly runId: string,
    private physics: PhysicsPort,
    private loads: readonly CarrierLoad[],
  ) {
    this.receipts = new BatchReceipts(runId);
    this.loads = structuredClone(loads);
    this.supply = getDeviceModule("material_source_station").createSupply(
      physics,
    );
    if (
      !physics.activateBodies ||
      !physics.deactivateBodies ||
      !physics.isBodyActive ||
      !physics.readBody ||
      !physics.hasGraspForBody
    )
      throw new Error("Finite physical body lifecycle is unavailable");
    const bodies = loads.flatMap((l) => [l.carrier, ...l.items]);
    if (
      new Set(bodies.map((b) => b.id)).size !== bodies.length ||
      new Set(bodies.map((b) => b.bodyId)).size !== bodies.length
    )
      throw new Error("Duplicate environment identity");
  }
  private time(tick: number) {
    if (!Number.isSafeInteger(tick) || tick < this.lastTick)
      throw new Error("Invalid environment tick");
    this.lastTick = tick;
  }
  private load(id: string) {
    const l = this.loads.find((l) => l.carrier.id === id);
    if (!l) throw new Error("Unknown carrier");
    return l;
  }
  private allBodies() {
    return this.loads.flatMap((l) => [l.carrier, ...l.items]);
  }
  admit(id: string, tick: number) {
    this.time(tick);
    const load = this.load(id);
    if (this.admitted.has(id)) return;
    const ordinal = this.loads.indexOf(load);
    if (
      this.loads.slice(0, ordinal).some((l) => !this.departed.has(l.carrier.id))
    )
      throw new Error("Previous carrier handoff is incomplete");
    const bodies = [load.carrier, ...load.items],
      presence = bodies.map((b) => this.physics.isBodyActive!(b.bodyId));
    if (presence.some(Boolean) && !presence.every(Boolean))
      throw new Error("Partial load already exists");
    if (!presence.every(Boolean)) {
      for (const body of bodies)
        for (const other of this.allBodies()) {
          if (!this.physics.isBodyActive!(other.bodyId)) continue;
          const p = this.physics.readBody!(other.bodyId);
          const rotation = new Quaternion(...p.rotation),
            half = other.size.map((v) => v / 2);
          const extents = [0, 0, 0];
          for (const x of [-1, 1])
            for (const y of [-1, 1])
              for (const z of [-1, 1]) {
                const corner = new Vector3(
                  x * half[0],
                  y * half[1],
                  z * half[2],
                ).applyQuaternion(rotation);
                corner
                  .toArray()
                  .forEach(
                    (v, i) => (extents[i] = Math.max(extents[i], Math.abs(v))),
                  );
              }
          if (
            body.initial.position.every(
              (v, i) =>
                Math.abs(v - p.position[i]) <
                body.size[i] / 2 + extents[i] - 0.001,
            )
          )
            throw new Error("Source volume is occupied");
        }
      this.supply.present(
        bodies.map((b) => ({ id: b.bodyId, pose: b.initial })),
      );
    }
    this.admitted.add(id);
    this.receipts.record(
      "supply_requested",
      id,
      bodies.map((b) => b.bodyId),
      tick,
      this.physics.readBody!(load.carrier.bodyId).position,
    );
  }
  observeSupply(id: string, tick: number) {
    this.time(tick);
    const load = this.load(id);
    if (!this.admitted.has(id) || this.confirmed.has(id))
      return this.confirmed.has(id);
    if (
      !this.physics.hasSupport(load.carrier.bodyId, load.sourceSupport) ||
      load.items.some(
        (i) => !this.physics.hasSupport(i.bodyId, load.carrier.bodyId),
      )
    )
      return false;
    const bodies = [load.carrier, ...load.items];
    if (
      bodies.some(
        (b) => Math.hypot(...this.physics.readBody!(b.bodyId).velocity) > 0.02,
      )
    )
      return false;
    this.confirmed.add(id);
    this.receipts.record(
      "supply_confirmed",
      id,
      bodies.map((b) => b.bodyId),
      tick,
      this.physics.readBody!(load.carrier.bodyId).position,
    );
    return true;
  }
  private arrived(body: EnvironmentBody, target: HandoffTarget) {
    if (
      !Number.isFinite(target.tolerance) ||
      target.tolerance <= 0 ||
      !Number.isFinite(target.speedTolerance) ||
      target.speedTolerance <= 0 ||
      !target.position.every(Number.isFinite) ||
      !target.referenceOffset.every(Number.isFinite)
    )
      throw new Error("Invalid handoff target");
    if (
      !this.physics.isBodyActive!(body.bodyId) ||
      this.physics.hasGraspForBody!(body.bodyId)
    )
      return false;
    const pose = this.physics.readBody!(body.bodyId),
      point = new Vector3(...target.referenceOffset)
        .applyQuaternion(new Quaternion(...pose.rotation))
        .add(new Vector3(...pose.position));
    return (
      point.distanceTo(new Vector3(...target.position)) <= target.tolerance &&
      Math.hypot(...pose.velocity) <= target.speedTolerance &&
      Math.hypot(...(pose.angularVelocity ?? [0, 0, 0])) <=
        target.speedTolerance &&
      this.physics.hasSupport(body.bodyId, target.supportId)
    );
  }
  deliverMaterial(id: string, target: HandoffTarget, tick: number) {
    this.time(tick);
    if (this.delivered.has(id)) return true;
    const load = this.loads.find((l) => l.items.some((i) => i.id === id)),
      body = load?.items.find((i) => i.id === id);
    if (!load || !body) throw new Error("Unknown material");
    if (!this.confirmed.has(load.carrier.id) || !this.arrived(body, target))
      return false;
    const position = this.physics.readBody!(body.bodyId).position;
    this.physics.deactivateBodies!([body.bodyId]);
    this.delivered.add(id);
    this.receipts.record(
      "material_delivered",
      id,
      [body.bodyId],
      tick,
      position,
    );
    return true;
  }
  takeCarrier(id: string, target: HandoffTarget, tick: number) {
    this.time(tick);
    if (this.departed.has(id)) return true;
    const load = this.load(id);
    if (
      !this.confirmed.has(id) ||
      load.items.some((i) => !this.delivered.has(i.id)) ||
      !this.arrived(load.carrier, target)
    )
      return false;
    const position = this.physics.readBody!(load.carrier.bodyId).position;
    this.physics.deactivateBodies!([load.carrier.bodyId]);
    this.departed.add(id);
    this.receipts.record(
      "carrier_departed",
      id,
      [load.carrier.bodyId],
      tick,
      position,
    );
    return true;
  }
  complete() {
    return this.loads.every(
      (l) =>
        this.departed.has(l.carrier.id) &&
        l.items.every((i) => this.delivered.has(i.id)),
    );
  }
  snapshot() {
    return this.receipts.snapshot();
  }
}

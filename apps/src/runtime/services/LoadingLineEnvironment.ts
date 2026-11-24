/** 按批次接纳空托盘和各供料线的物料，核实机械臂放置后登记槽位占用，并在满盘到达出口时生成交付回执。 */

import { Quaternion, Vector3 } from "three";
import type {
  CompiledSceneRuntime,
  LoadingConfig,
} from "@/contracts/scene-execution";
import type { PhysicsPort } from "@/contracts/physics";
import type { ObservationWrite } from "@/contracts/conditions";
import type { ActionRequest } from "@/contracts/scheduler";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import type {
  TransportTarget,
  PositionTransportConfig,
} from "@/runtime/adapters/scene/PositionTransportAdapter";
import type { EnvironmentReceipt } from "./FiniteSceneEnvironment";
import type { SceneConditionWorld } from "@/runtime/assembly/SceneConditionBindings";

/** Manages finite admission and receiver receipts. Only DSL actions can move or load a pallet. */
export class LoadingLineEnvironment implements DeviceActionPort {
  readonly id = "@loading-environment";
  private stopped = false;
  private nextPallet = 0;
  private confirmed = new Set<string>();
  private receipts: EnvironmentReceipt[] = [];
  private deliveries: SceneConditionWorld["deliveries"] = {};
  private slots: Record<string, string> = {};
  private pending?: ObservationWrite;
  private readonly sourceOffset = new Map<string, number>();
  private readonly itemById;
  private readonly config: LoadingConfig;

  constructor(
    private runId: string,
    private compiled: CompiledSceneRuntime,
    private physics: PhysicsPort,
    private drives: ReadonlyMap<string, PositionTransportConfig>,
    private fitsSlot: (material: string) => boolean,
  ) {
    this.config = compiled.loading!;
    this.itemById = new Map(
      this.config.pallets.flatMap((p) =>
        p.items.map((i) => [i.material, i] as const),
      ),
    );
  }
  private get current() {
    return this.config.pallets[this.nextPallet];
  }
  private body(id: string) {
    return this.compiled.bodyMap.get(id + "/body")!;
  }
  private active(id: string) {
    return this.physics.isBodyActive!(this.body(id).id);
  }
  private append(
    kind: EnvironmentReceipt["kind"],
    id: string,
    tick: number,
    bodyIds: string[],
  ) {
    this.receipts.push({
      kind,
      sequence: this.receipts.length + 1,
      runId: this.runId,
      tick,
      subjectId: id,
      bodyIds,
      position: this.physics.readBody!(this.body(id).id).position,
    });
  }
  private admit(id: string) {
    if (this.active(id)) return;
    const b = this.body(id);
    this.physics.activateBodies!([
      {
        id: b.id,
        pose: {
          position: b.position,
          rotation: b.rotation,
          velocity: [0, 0, 0],
        },
      },
    ]);
  }
  private confirmSupport(id: string, support: string, tick: number) {
    if (this.confirmed.has(id) || !this.active(id)) return;
    const b = this.body(id);
    if (!this.settledOn(id, support)) return;
    this.confirmed.add(id);
    this.append("supply_confirmed", id, tick, [b.id]);
  }
  private settledOn(id: string, support: string) {
    const b = this.body(id);
    if (!this.active(id) || !this.physics.hasContactSupport!(b.id, support))
      return false;
    const pose = this.physics.readBody!(b.id);
    return (
      Math.hypot(...pose.velocity) <= 0.025 &&
      Math.hypot(...(pose.angularVelocity ?? [])) <= 0.12
    );
  }
  private supplied(route: LoadingConfig["supplies"][number]) {
    return route.materials[this.sourceOffset.get(route.device) ?? 0];
  }
  beforePhysics() {
    if (this.stopped || !this.current) return;
    this.admit(this.current.id);
    for (const route of this.config.supplies) {
      const id = this.supplied(route);
      if (!id || !this.current.items.some((i) => i.material === id)) continue;
      this.admit(id);
      // The feeder support bridges its GLB rest position to the inlet of its own branch.
      const speed = this.physics.getSurfaceSpeed!(
        route.entryDevice + "/surface",
      );
      this.physics.setSurfaceSpeeds!({ [route.device + "/surface"]: speed });
    }
  }
  recordPlacement(r: ActionRequest) {
    if (r.runId !== this.runId || r.behavior !== "pick_and_place") return;
    const fields = (
      r.payload as { fields: { material: string; target: string } }
    ).fields;
    const item = this.itemById.get(fields.material),
      route = this.config.supplies.find(
        (s) => this.supplied(s) === fields.material,
      );
    if (
      !route ||
      item?.target !== fields.target ||
      !this.current?.items.includes(item) ||
      this.slots[item.target] ||
      !this.fitsSlot(item.material)
    )
      throw new Error(
        "Loading handoff evidence differs from the pallet manifest: " +
          fields.material,
      );
    this.slots[item.target] = item.material;
    this.deliveries[item.material] = {
      handler: r.device,
      receiver: this.current.id,
      target: item.target,
    };
    this.sourceOffset.set(
      route.device,
      (this.sourceOffset.get(route.device) ?? 0) + 1,
    );
  }
  private atExit(target: TransportTarget) {
    if (!this.current || !this.active(this.current.id)) return false;
    const config = this.drives.get(this.config.exchange.leader)!;
    const sub = config.subjects.get(
      this.compiled.subjectIds.get(this.current.id)!,
    )!;
    const pose = this.physics.readBody!(sub.bodyId);
    const point = new Vector3(...sub.referenceOffset)
      .applyQuaternion(new Quaternion(...pose.rotation))
      .add(new Vector3(...pose.position));
    return (
      point.distanceTo(new Vector3(...target.position)) <=
        config.positionTolerance &&
      Math.hypot(...pose.velocity) <= config.speedTolerance &&
      target.supportIds.some((s) => this.physics.hasSupport(sub.bodyId, s))
    );
  }
  releasePallet(id: string, target: TransportTarget, tick: number) {
    const p = this.current;
    if (
      this.stopped ||
      p?.id !== id ||
      target.id !== this.config.exchange.exit ||
      !this.atExit(target) ||
      !p.items.every(
        (i) => this.slots[i.target] === i.material && this.fitsSlot(i.material),
      )
    )
      return false;
    const ids = [
      ...p.items.map((i) => this.body(i.material).id),
      this.body(id).id,
    ];
    const position = this.physics.readBody!(this.body(id).id).position;
    this.physics.deactivateBodies!(ids);
    this.receipts.push({
      sequence: this.receipts.length + 1,
      runId: this.runId,
      kind: "carrier_departed",
      subjectId: id,
      bodyIds: ids,
      position,
      tick,
    });
    this.nextPallet++;
    return true;
  }
  get initialStable() {
    return (
      !!this.current &&
      this.confirmed.has(this.current.id) &&
      this.settledOn(this.current.id, this.compiled.entryDevice + "/surface") &&
      this.config.supplies.every(
        (s) =>
          this.confirmed.has(s.materials[0]) &&
          this.settledOn(s.materials[0], s.device + "/surface"),
      )
    );
  }
  get diagnostic() {
    return [
      this.current?.id,
      ...this.config.supplies.map((s) => s.materials[0]),
    ]
      .filter((id) => id && !this.confirmed.has(id))
      .join(", ");
  }
  afterPhysics(_dt: number, tick: number) {
    if (this.current)
      this.confirmSupport(
        this.current.id,
        this.compiled.entryDevice + "/surface",
        tick,
      );
    for (const route of this.config.supplies) {
      const id = this.supplied(route);
      if (id) this.confirmSupport(id, route.device + "/surface", tick);
    }
    const bodies: SceneConditionWorld["bodies"] = {};
    const supports = this.compiled.physics.surfaces!.flatMap((s) => [
      s.id,
      ...(s.aliases ?? []),
    ]);
    for (const b of this.compiled.bodyMap.values()) {
      const active = this.physics.isBodyActive!(b.id);
      bodies[b.id] = {
        active,
        pose: active ? this.physics.readBody!(b.id) : undefined,
        held: active && this.physics.hasGraspForBody!(b.id),
        supports:
          active && b.motionType === "dynamic"
            ? supports.filter((s) => this.physics.hasSupport(b.id, s))
            : [],
      };
    }
    const robotClear: Record<string, boolean> = {};
    for (const [id, r] of this.compiled.robots) {
      const state = bodies[r.toolBodyId],
        home = this.compiled.devices.get(id)!.locations[id + ".home"].position;
      robotClear[id] =
        !!state.pose &&
        !state.held &&
        new Vector3(...state.pose.position).distanceTo(new Vector3(...home)) <=
          2 * r.tolerance &&
        Math.hypot(...state.pose.velocity) <= 0.03;
    }
    const exit = this.drives
      .get(this.config.exchange.leader)!
      .targets.find((t) => t.id === this.config.exchange.exit)!;
    const fullAtExit =
      !!this.current &&
      this.atExit(exit) &&
      this.current.items.every(
        (i) => this.slots[i.target] === i.material && this.fitsSlot(i.material),
      );
    const value: SceneConditionWorld = {
      bodies,
      robotClear,
      receipts: this.receipts,
      deliveries: this.deliveries,
      loading: {
        pallet: this.current?.id ?? null,
        slots: this.slots,
        fullAtExit,
      },
    };
    this.pending = {
      key: "world/state",
      provider: "physics",
      runId: this.runId,
      value,
    };
  }
  supports() {
    return false;
  }
  prepare(): never {
    throw new Error("Loading supply follows finite admission");
  }
  submit(): never {
    throw new Error("External environment cannot execute a DSL call");
  }
  cancel() {}
  prepareCancel() {
    return [];
  }
  prepareStop() {
    return [];
  }
  requestStop() {
    this.stopped = true;
    for (const s of this.config.supplies)
      this.physics.setSurfaceSpeeds!({ [s.device + "/surface"]: 0 });
  }
  isStopped() {
    return this.config.supplies.every(
      (s) => this.physics.getSurfaceSpeed!(s.device + "/surface") === 0,
    );
  }
  drainSignals() {
    return [];
  }
  drainFeedback() {
    return [];
  }
  drainObservations() {
    const w = this.pending;
    this.pending = undefined;
    return w ? [w] : [];
  }
  dispose() {}
}

/** 托盘工艺的有限供料、位置归属和物理回执。工步的目标与次序来自调度器。 */
import { Quaternion, Vector3 } from "three";
import { getDeviceModule } from "@/devices/registry";
import type { RuntimeBody, PhysicsPort } from "@/contracts/physics";
import type { ActionRequest } from "@/contracts/scheduler";
import type { ObservationWrite } from "@/contracts/conditions";
import type {
  PositionTransportConfig,
  TransportTarget,
} from "@/devices/conveyor/behavior";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import type { SceneConditionWorld } from "@/runtime/assembly/SceneConditionBindings";
import { BatchReceipts } from "./FiniteBatchLifecycle";

interface BatchCarrier {
  id: string;
  items: { material: string; source?: string; target?: string }[];
  slots: string[];
  bindLoads: boolean;
}
export interface CarrierBatchPlan {
  carriers: BatchCarrier[];
  /** Source and conveyor surface for each finite feeder queue. */
  feeders: { device: string; entryDevice: string; materials: string[] }[];
  entrySupport: string;
  entryDrive?: string;
  exit: string;
  drive: PositionTransportConfig;
  workpoint?: {
    location: string;
    station: string;
    robot: string;
  };
}
interface BatchObservations {
  bodies: ReadonlyMap<string, RuntimeBody>;
  supports: string[];
  subjectIds: ReadonlyMap<string, number>;
  fits(material: string, location: string): boolean;
  robotHome(): Record<string, boolean>;
}

export class CarrierBatchRuntime implements DeviceActionPort {
  readonly id = "@carrier-batch";
  private stopped = false;
  private next = 0;
  private readonly slots;
  private readonly supply;
  private readonly feedIndex = new Map<string, number>();
  private readonly receipts: BatchReceipts;
  private readonly deliveries: SceneConditionWorld["deliveries"] = {};
  readonly workpoint;
  private readonly captured = new Set<string>();
  private pending?: ObservationWrite;

  constructor(
    private runId: string,
    private physics: PhysicsPort,
    private plan: CarrierBatchPlan,
    private read: BatchObservations,
  ) {
    const p = plan.workpoint;
    this.workpoint = p
      ? getDeviceModule("machine_tool").createWorkpoint(
          (material) =>
            !this.stopped &&
            this.workItem === material &&
            this.read.robotHome()[p.robot] &&
            this.read.fits(material, p.location),
        )
      : undefined;
    this.receipts = new BatchReceipts(runId);
    this.slots = getDeviceModule("workpiece").createInventory([
      ...plan.carriers.flatMap((p) => p.slots),
      ...(plan.workpoint ? [plan.workpoint.location] : []),
    ]);
    for (const carrier of plan.carriers)
      for (const item of carrier.items)
        if (item.source) this.slots.load(item.source, item.material);
    this.supply = getDeviceModule("material_source_station").createSupply(
      physics,
    );
  }

  private get carrier() {
    return this.plan.carriers[this.next];
  }
  private get workItem() {
    return this.plan.workpoint
      ? (this.slots.at(this.plan.workpoint.location) ?? null)
      : null;
  }
  private body(id: string) {
    return this.read.bodies.get(id + "/body")!;
  }
  private currentFeed(route: CarrierBatchPlan["feeders"][number]) {
    return route.materials[this.feedIndex.get(route.device) ?? 0];
  }
  private conveySource(source: string, drive: string) {
    this.physics.setSurfaceSpeeds!({
      [source]: this.physics.getSurfaceSpeed!(drive),
    });
  }
  beforePhysics() {
    const p = this.carrier;
    if (this.stopped || !p) return;
    if (!this.physics.isBodyActive!(this.body(p.id).id)) {
      const initial = p.items
        .filter((i) => i.source)
        .map((i) => this.body(i.material));
      this.supply.presentAtRest([this.body(p.id), ...initial]);
    }
    if (this.plan.entryDrive)
      this.conveySource(this.plan.entrySupport, this.plan.entryDrive);
    for (const route of this.plan.feeders) {
      const id = this.currentFeed(route);
      if (!id || !p.items.some((i) => i.material === id)) continue;
      const b = this.body(id);
      if (!this.physics.isBodyActive!(b.id)) this.supply.presentAtRest([b]);
      this.conveySource(
        route.device + "/surface",
        route.entryDevice + "/surface",
      );
    }
  }

  /** Commit the driver's actual handoff against the source and target of this exact request. */
  recordPlacement(r: ActionRequest) {
    if (
      r.runId !== this.runId ||
      r.behavior !== "pick_and_place" ||
      this.captured.has(r.requestId)
    )
      return;
    const { material, source, target } = (
      r.payload as { fields: Record<string, string> }
    ).fields;
    const carrier = this.carrier,
      item = carrier?.items.find((i) => i.material === material);
    const route = this.plan.feeders.find(
      (s) => this.currentFeed(s) === material,
    );
    const p = this.plan.workpoint;
    const ownedSource = this.slots.at(source) === material;
    if (
      !carrier ||
      !item ||
      (!ownedSource && !route) ||
      this.slots.at(target) ||
      (!carrier.slots.includes(target) && target !== p?.location) ||
      !this.read.fits(material, target)
    )
      throw new Error(
        "Placement lacks matching material, endpoint or support: " + material,
      );
    if (carrier.bindLoads && target !== p?.location)
      this.physics.bindLoad!(this.body(carrier.id).id, this.body(material).id);
    if (ownedSource) this.slots.unload(source, material);
    this.slots.load(target, material, r.requestId);
    if (route)
      this.feedIndex.set(
        route.device,
        (this.feedIndex.get(route.device) ?? 0) + 1,
      );
    if (carrier.slots.includes(target))
      this.deliveries[material] = {
        handler: r.device,
        receiver: carrier.id,
        target,
      };
    this.captured.add(r.requestId);
  }

  private at(target: TransportTarget) {
    if (!this.carrier) return false;
    const drive = this.plan.drive;
    const sub = drive.subjects.get(this.read.subjectIds.get(this.carrier.id)!)!;
    if (!this.physics.isBodyActive!(sub.bodyId)) return false;
    const pose = this.physics.readBody!(sub.bodyId);
    const ref = new Vector3(...sub.referenceOffset)
      .applyQuaternion(new Quaternion(...pose.rotation))
      .add(new Vector3(...pose.position));
    return (
      ref.distanceTo(new Vector3(...target.position)) <=
        drive.positionTolerance &&
      Math.hypot(...pose.velocity) <= drive.speedTolerance &&
      target.supportIds.some((id) =>
        this.physics.hasContactSupport!(sub.bodyId, id),
      )
    );
  }
  private completeLoad() {
    const carrier = this.carrier;
    return (
      !!carrier &&
      carrier.items.every((i) => {
        const slot = this.slots.slotOf(i.material);
        return (
          !!slot &&
          carrier.slots.includes(slot) &&
          this.read.fits(i.material, slot) &&
          (!carrier.bindLoads ||
            this.physics.isCarriedBy!(
              this.body(i.material).id,
              this.body(carrier.id).id,
            ))
        );
      })
    );
  }
  releasePallet(id: string, target: TransportTarget, tick: number) {
    if (this.receipts.has("carrier_departed", id)) return true;
    const p = this.carrier;
    if (
      this.stopped ||
      !p ||
      p.id !== id ||
      target.id !== this.plan.exit ||
      !this.at(target) ||
      !this.completeLoad()
    )
      return false;
    const carrier = this.body(id).id,
      loads = p.items.map((i) => this.body(i.material).id);
    const position = this.physics.readBody!(carrier).position;
    if (p.bindLoads) this.physics.departLoadedCarrier!(carrier, loads);
    else this.physics.deactivateBodies!([...loads, carrier]);
    this.receipts.record(
      "carrier_departed",
      id,
      [carrier, ...loads],
      tick,
      position,
    );
    this.next++;
    return true;
  }
  get initialStable() {
    const p = this.carrier;
    return (
      !!p &&
      this.receipts.has("supply_confirmed", p.id) &&
      this.plan.feeders.every(
        (s) =>
          !s.materials.length ||
          this.receipts.has("supply_confirmed", s.materials[0]),
      )
    );
  }
  get diagnostic() {
    return [
      this.carrier?.id,
      ...this.plan.feeders.map((s) => this.currentFeed(s)),
    ]
      .filter(Boolean)
      .join(", ");
  }
  private observeAdmission(tick: number) {
    const p = this.carrier;
    if (!p) return;
    const body = this.body(p.id).id;
    if (
      !this.receipts.has("supply_confirmed", p.id) &&
      this.physics.isBodyActive!(body) &&
      this.supply.settledOn(
        body,
        this.plan.entrySupport,
        this.plan.drive.speedTolerance,
        0.12,
      ) &&
      p.items.every(
        (i) =>
          !i.source ||
          (this.physics.isCarriedBy!(this.body(i.material).id, body) &&
            this.read.fits(i.material, i.source)),
      )
    )
      this.receipts.record(
        "supply_confirmed",
        p.id,
        [
          body,
          ...p.items
            .filter((i) => i.source)
            .map((i) => this.body(i.material).id),
        ],
        tick,
        this.physics.readBody!(body).position,
      );
    for (const s of this.plan.feeders) {
      const id = this.currentFeed(s);
      if (!id || this.receipts.has("supply_confirmed", id)) continue;
      const b = this.body(id).id;
      if (
        this.physics.isBodyActive!(b) &&
        this.supply.settledOn(b, s.device + "/surface", 0.025, 0.12)
      )
        this.receipts.record(
          "supply_confirmed",
          id,
          [b],
          tick,
          this.physics.readBody!(b).position,
        );
    }
  }
  afterPhysics(_dt: number, tick: number) {
    this.observeAdmission(tick);
    const bodies: SceneConditionWorld["bodies"] = {};
    for (const b of this.read.bodies.values()) {
      const active = this.physics.isBodyActive!(b.id);
      bodies[b.id] = {
        active,
        pose: active ? this.physics.readBody!(b.id) : undefined,
        held: active && this.physics.hasGraspForBody!(b.id),
        supports:
          active && b.motionType === "dynamic"
            ? this.read.supports.filter(
                (s) => s !== b.id && this.physics.hasSupport(b.id, s),
              )
            : [],
      };
    }
    const p = this.plan.workpoint;
    const at = (id: string) =>
      this.at(this.plan.drive.targets.find((t) => t.id === id)!);
    const completedLoad = this.completeLoad();
    const state = {
      pallet: this.carrier?.id ?? null,
      slots: this.slots.snapshot(),
      fullAtExit: completedLoad && at(this.plan.exit),
    };
    const world: SceneConditionWorld = {
      bodies,
      robotClear: this.read.robotHome(),
      receipts: this.receipts.current(),
      deliveries: this.deliveries,
    };
    if (p && this.workpoint) {
      for (const carrier of this.plan.carriers)
        for (const item of carrier.items)
          bodies[this.body(item.material).id].materialState =
            this.workpoint.stateOf(item.material);
      world.machining = {
        ...state,
        atStation: at(p.station),
        completedLoad,
        machineItem: this.workItem,
        workSupported:
          !!this.workItem && this.read.fits(this.workItem, p.location),
        operations: this.workpoint.snapshot(),
      };
    } else world.loading = state;
    this.pending = {
      key: "world/state",
      provider: "physics",
      runId: this.runId,
      value: world,
    };
  }
  supports() {
    return false;
  }
  prepare(): never {
    throw new Error("Batch observations accept no device commands");
  }
  submit(): never {
    throw new Error("Batch observations accept no device commands");
  }
  cancel() {}
  prepareCancel() {
    return [];
  }
  prepareStop() {
    return [];
  }
  private get sources() {
    return [
      ...this.plan.feeders.map((s) => s.device + "/surface"),
      ...(this.plan.entryDrive ? [this.plan.entrySupport] : []),
    ];
  }
  requestStop() {
    this.stopped = true;
    this.physics.setSurfaceSpeeds!(
      Object.fromEntries(this.sources.map((id) => [id, 0])),
    );
  }
  isStopped() {
    return this.sources.every((id) => this.physics.getSurfaceSpeed!(id) === 0);
  }
  drainSignals() {
    return [];
  }
  drainFeedback() {
    return [];
  }
  drainObservations() {
    const pending = this.pending;
    this.pending = undefined;
    return pending ? [pending] : [];
  }
  dispose() {}
}

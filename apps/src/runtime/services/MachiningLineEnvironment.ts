import { Quaternion, Vector3 } from "three";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import type { PhysicsPort } from "@/contracts/physics";
import type { ActionRequest } from "@/contracts/scheduler";
import type { ObservationWrite } from "@/contracts/conditions";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import type {
  TransportTarget,
  PositionTransportConfig,
} from "@/runtime/adapters/scene/PositionTransportAdapter";
import type { SceneConditionWorld } from "@/runtime/assembly/SceneConditionBindings";
import type { EnvironmentReceipt } from "./FiniteSceneEnvironment";

/** Physical custody and process state for a pallet whose loads must return to their original slots. */
export class MachiningLineEnvironment implements DeviceActionPort {
  readonly id = "@machining-environment";
  private stopped = false;
  private next = 0;
  private readonly slots: Record<string, string> = {};
  private machineItem: string | null = null;
  private readonly operations: {
    material: string;
    request: string;
    tick: number;
  }[] = [];
  private readonly finished = new Set<string>();
  private readonly receipts: EnvironmentReceipt[] = [];
  private pending?: ObservationWrite;
  private readonly config;
  private readonly supportIds;

  constructor(
    private runId: string,
    private compiled: CompiledSceneRuntime,
    private physics: PhysicsPort,
    private drive: PositionTransportConfig,
    private fits: (material: string, target: string) => boolean,
    private robotStopped: () => boolean,
  ) {
    this.config = compiled.machining!;
    this.supportIds = [
      ...compiled.physics.surfaces!.flatMap((s) => [
        s.id,
        ...(s.aliases ?? []),
      ]),
      this.config.machine + "/support",
      ...this.config.pallets.map((p) => p.id + "/body"),
    ];
    for (const p of this.config.pallets)
      for (const item of p.items) this.slots[item.source] = item.material;
  }
  private get pallet() {
    return this.config.pallets[this.next];
  }
  private robotHome() {
    const robot = this.compiled.robots.get(this.config.robot)!;
    const home = this.compiled.devices.get(this.config.robot)!.locations[
      this.config.robot + ".home"
    ];
    const pose = this.physics.readBody!(robot.toolBodyId);
    return (
      this.robotStopped() &&
      new Vector3(...pose.position).distanceTo(new Vector3(...home.position)) <=
        2 * robot.tolerance &&
      !!home.rotation_quaternion &&
      new Quaternion(...pose.rotation).angleTo(
        new Quaternion(...home.rotation_quaternion),
      ) <= 0.05
    );
  }
  private at(target: TransportTarget) {
    if (!this.pallet) return false;
    const subject = this.drive.subjects.get(
      this.compiled.subjectIds.get(this.pallet.id)!,
    )!;
    if (!this.physics.isBodyActive!(subject.bodyId)) return false;
    const pose = this.physics.readBody!(subject.bodyId);
    const ref = new Vector3(...subject.referenceOffset)
      .applyQuaternion(new Quaternion(...pose.rotation))
      .add(new Vector3(...pose.position));
    return (
      ref.distanceTo(new Vector3(...target.position)) <=
        this.drive.positionTolerance &&
      Math.hypot(...pose.velocity) <= this.drive.speedTolerance &&
      target.supportIds.some((s) =>
        this.physics.hasContactSupport!(subject.bodyId, s),
      )
    );
  }
  private completeLoad() {
    return (
      !!this.pallet &&
      !this.machineItem &&
      this.pallet.items.every(
        (i) =>
          this.finished.has(i.material) &&
          this.slots[i.source] === i.material &&
          this.physics.isCarriedBy!(
            i.material + "/body",
            this.pallet!.id + "/body",
          ) &&
          this.fits(i.material, i.source),
      )
    );
  }
  recordPlacement(r: ActionRequest) {
    if (r.behavior !== "pick_and_place" || r.runId !== this.runId) return;
    const f = (r.payload as { fields: Record<string, string> }).fields;
    const item = this.pallet?.items.find((i) => i.material === f.material);
    if (!item || !this.fits(item.material, f.target))
      throw new Error("Placement lacks physical evidence: " + f.material);
    if (
      f.target === this.config.point &&
      f.source === item.source &&
      this.slots[item.source] === item.material &&
      !this.finished.has(item.material) &&
      !this.machineItem
    ) {
      delete this.slots[item.source];
      this.machineItem = item.material;
    } else if (
      f.source === this.config.point &&
      f.target === item.source &&
      this.machineItem === item.material &&
      this.finished.has(item.material) &&
      !this.slots[item.source]
    ) {
      this.physics.bindLoad!(
        this.pallet!.id + "/body",
        item.material + "/body",
      );
      this.slots[item.source] = item.material;
      this.machineItem = null;
    } else throw new Error("Unexpected machining handoff: " + item.material);
  }
  ready(material: string) {
    return (
      !this.stopped &&
      this.machineItem === material &&
      !this.finished.has(material) &&
      this.robotHome() &&
      this.fits(material, this.config.point)
    );
  }
  finish(material: string, request: string, tick: number) {
    if (!this.ready(material))
      throw new Error("Lost machining interlock: " + material);
    this.finished.add(material);
    this.operations.push({ material, request, tick });
  }
  releasePallet(id: string, target: TransportTarget, tick: number) {
    if (
      this.stopped ||
      this.pallet?.id !== id ||
      target.id !== this.config.exitTarget ||
      !this.at(target) ||
      !this.completeLoad() ||
      !this.robotHome()
    )
      return false;
    const carrier = id + "/body",
      loads = this.pallet.items.map((i) => i.material + "/body");
    const position = this.physics.readBody!(carrier).position;
    this.physics.departLoadedCarrier!(carrier, loads);
    this.receipts.push({
      kind: "carrier_departed",
      sequence: this.receipts.length + 1,
      runId: this.runId,
      subjectId: id,
      tick,
      bodyIds: [carrier, ...loads],
      position,
    });
    this.next++;
    return true;
  }
  get initialStable() {
    return this.receipts.some((r) => r.kind === "supply_confirmed");
  }
  get diagnostic() {
    return this.pallet?.id + " on " + this.compiled.sourceDevice;
  }
  beforePhysics() {
    if (this.stopped || !this.pallet) return;
    const p = this.pallet;
    if (!this.physics.isBodyActive!(p.id + "/body")) {
      const bodies = [p.id, ...p.items.map((i) => i.material)].map((id) =>
        this.compiled.bodyMap.get(id + "/body")!,
      );
      this.physics.activateBodies!(
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
    this.physics.setSurfaceSpeeds!({
      [this.compiled.sourceDevice + "/surface"]: this.physics.getSurfaceSpeed!(
        this.compiled.entryDevice + "/surface",
      ),
    });
  }
  afterPhysics(_dt: number, tick: number) {
    const p = this.pallet;
    if (
      p &&
      !this.receipts.some(
        (r) => r.subjectId === p.id && r.kind === "supply_confirmed",
      )
    ) {
      const body = p.id + "/body",
        pose = this.physics.readBody!(body);
      if (
        this.physics.hasContactSupport!(
          body,
          this.compiled.sourceDevice + "/surface",
        ) &&
        Math.hypot(...pose.velocity) <= this.drive.speedTolerance &&
        p.items.every(
          (i) =>
            this.physics.isCarriedBy!(i.material + "/body", body) &&
            this.fits(i.material, i.source),
        )
      )
        this.receipts.push({
          kind: "supply_confirmed",
          sequence: this.receipts.length + 1,
          runId: this.runId,
          subjectId: p.id,
          tick,
          bodyIds: [body, ...p.items.map((i) => i.material + "/body")],
          position: pose.position,
        });
    }
    const bodies: SceneConditionWorld["bodies"] = {};
    for (const b of this.compiled.bodyMap.values()) {
      const active = this.physics.isBodyActive!(b.id);
      bodies[b.id] = {
        active,
        pose: active ? this.physics.readBody!(b.id) : undefined,
        held: active && this.physics.hasGraspForBody!(b.id),
        supports:
          active && b.motionType === "dynamic"
            ? this.supportIds.filter(
                (s) => s !== b.id && this.physics.hasSupport(b.id, s),
              )
            : [],
      };
    }
    for (const pallet of this.config.pallets)
      for (const i of pallet.items)
        bodies[i.material + "/body"].materialState = this.finished.has(
          i.material,
        )
          ? "finished"
          : "raw";
    const completedLoad = this.completeLoad();
    const at = (id: string) =>
      this.at(this.drive.targets.find((t) => t.id === id)!);
    const value: SceneConditionWorld = {
      bodies,
      receipts: [...this.receipts],
      deliveries: {},
      robotClear: { [this.config.robot]: this.robotHome() },
      machining: {
        pallet: p?.id ?? null,
        atStation: at(this.config.stationTarget),
        completedLoad,
        fullAtExit: completedLoad && at(this.config.exitTarget),
        machineItem: this.machineItem,
        slots: { ...this.slots },
        operations: [...this.operations],
        workSupported:
          !!this.machineItem && this.fits(this.machineItem, this.config.point),
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
    throw new Error("Machining environment has no DSL actions");
  }
  submit(): never {
    throw new Error("Machining environment has no DSL actions");
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
    this.physics.setSurfaceSpeeds!({
      [this.compiled.sourceDevice + "/surface"]: 0,
    });
  }
  isStopped() {
    return (
      this.physics.getSurfaceSpeed!(this.compiled.sourceDevice + "/surface") ===
      0
    );
  }
  drainSignals() {
    return [];
  }
  drainFeedback() {
    return [];
  }
  drainObservations() {
    const observation = this.pending;
    this.pending = undefined;
    return observation ? [observation] : [];
  }
  dispose() {}
}

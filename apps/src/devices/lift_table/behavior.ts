/** 将升降台的高度或具名工位换算为升降轴目标。接放料时检查对位与支承，再交给物料转移服务执行直线交接。 */

import { Vector3 } from "three";
import type { ActionRequest } from "@/contracts/scheduler";
import type { BodyPose, PhysicsPort, RuntimeBody } from "@/contracts/physics";
import type { WarehouseLocation, WarehouseConfig, WarehouseAssembly } from "@/contracts/warehouse";
import { MountedAxisMotion } from "@/runtime/engine/MountedAxisMotion";
import { sweptLoadBlocker } from "@/domain/runtime/warehouseClearance";
import { axisJob, LinearAxisTrajectory } from "@/runtime/mechanisms/LinearAxisTrajectory";
import { resolveDock } from "@/domain/runtime/DockingTargetResolver";
import { WarehouseActionAdapter } from "@/runtime/adapters/scene/WarehouseActionAdapter";
export class RailMountedLift {
  readonly rail: LinearAxisTrajectory;
  readonly lift: LinearAxisTrajectory;
  transferring = false;
  held?: string;
  private motion: MountedAxisMotion;
  private mastRest: BodyPose;
  private platformRest: BodyPose;
  constructor(
    readonly config: WarehouseAssembly,
    readonly physics: PhysicsPort,
  ) {
    this.rail = new LinearAxisTrajectory(
      0,
      config.railSpeed,
      config.railAccel,
      config.railLimits,
    );
    this.lift = new LinearAxisTrajectory(
      0,
      config.liftSpeed,
      config.liftAccel,
      config.liftLimits,
    );
    this.motion = new MountedAxisMotion(physics);
    const rail = { direction: config.axis, drive: this.rail };
    const lift = { direction: config.vertical, drive: this.lift };
    this.mastRest = this.motion.bind(config.mast, [rail]);
    this.platformRest = this.motion.bind(config.platform, [rail, lift]);
  }
  get anchor() {
    return new Vector3(...this.config.anchor)
      .addScaledVector(new Vector3(...this.config.axis), this.rail.position)
      .addScaledVector(new Vector3(...this.config.vertical), this.lift.position)
      .toArray();
  }
  get stopped() {
    return this.rail.settled && this.lift.settled && !this.transferring;
  }
  move(axis: "rail" | "lift", target: number) {
    if (!this.stopped) throw new Error("Mounted axes/transfer busy");
    this[axis].command(target);
  }
  stop() {
    this.rail.stop();
    this.lift.stop();
  }
  beforePhysics(dt: number) {
    this.motion.step(dt);
  }
  actual(axis: "rail" | "lift") {
    const mast = this.physics.readBody!(this.config.mast),
      platform = this.physics.readBody!(this.config.platform);
    return axis === "rail"
      ? new Vector3(...mast.position)
          .sub(new Vector3(...this.mastRest.position))
          .dot(new Vector3(...this.config.axis))
      : new Vector3(...platform.position)
          .sub(new Vector3(...this.platformRest.position))
          .dot(new Vector3(...this.config.vertical));
  }
  at(axis: "rail" | "lift", target: number) {
    return (
      this[axis].settled &&
      Math.abs(this.actual(axis) - target) < 0.005 &&
      Math.hypot(
        ...this.physics.readBody!(
          axis === "rail" ? this.config.mast : this.config.platform,
        ).velocity,
      ) < 0.01
    );
  }
  checkLoadedPath(
    axis: "rail" | "lift",
    target: number,
    material: { body: string; size: [number, number, number] } | undefined,
    bodies: readonly RuntimeBody[],
    poses: Readonly<Record<string, { active: boolean; pose?: BodyPose }>>,
  ) {
    if (!material) return;
    const from = poses[material.body]?.pose?.position;
    if (!from) throw new Error("Missing held load observation");
    const direction = axis === "rail" ? this.config.axis : this.config.vertical;
    const to = new Vector3(...from)
      .addScaledVector(new Vector3(...direction), target - this.actual(axis))
      .toArray();
    const ignored = new Set([
      material.body,
      this.config.platform,
      this.config.tool,
      ...(axis === "rail" ? [this.config.mast] : []),
    ]);
    const blocker = sweptLoadBlocker(
      from,
      to,
      material.size,
      bodies,
      poses,
      ignored,
    );
    if (blocker)
      throw new Error(
        `TARGET_UNREACHABLE: ${this.config.lift} loaded ${axis} motion intersects ${blocker}`,
      );
  }
}

/** 为独立安装的升降轴绑定高度设定、实测到位与停止协议。 */
export function createLiftAxisDriver(
  sceneId: string,
  runId: string,
  id: string,
  drive: LinearAxisTrajectory,
  rest: number,
  actual: () => number,
  stopped: () => boolean,
  at: (displacement: number) => boolean,
  move: (displacement: number) => void,
) {
  return new WarehouseActionAdapter(
    id,
    sceneId,
    runId,
    ["lift_to_level"],
    (request) => {
      const value = request.arguments.move_to_level as {
        value: number;
        unit: string;
      };
      const displacement = value.value - rest;
      if (
        value.unit !== "m" ||
        !Number.isFinite(displacement) ||
        displacement < drive.limits[0] ||
        displacement > drive.limits[1]
      )
        throw new Error("Invalid lift target");
      return axisJob(drive, displacement, false, move, at, () => drive.stop());
    },
    stopped,
    () => ({
      actual_height: rest + actual(),
      moving: !stopped(),
      at_level: stopped(),
    }),
  );
}

export interface TransferRequest {
  material: string;
  source: string;
  target: string;
  request: ActionRequest;
}
export interface TransferLifecycle {
  validate(t: TransferRequest): void;
  begin(t: TransferRequest): void;
  commit(t: TransferRequest, tick: number): void;
}
export function transferFields(
  lift: string,
  r: ActionRequest,
): TransferRequest {
  const p = r.payload as { binding?: string; fields?: Record<string, string> };
  if (
    p?.binding !== lift + "." + r.behavior ||
    !p.fields ||
    typeof p.fields.material !== "string"
  )
    throw new Error("Invalid transfer payload identity");
  const f = p.fields,
    source = r.behavior === "release_material" ? lift + ".work" : f.source,
    target = r.behavior === "accept_material" ? lift + ".work" : f.target;
  const expected =
    r.behavior === "transfer_material"
      ? ["material", "source", "target"]
      : ["material", r.behavior === "accept_material" ? "source" : "target"];
  if (
    Object.keys(f).length !== expected.length ||
    expected.some((k) => typeof f[k] !== "string") ||
    source === target ||
    (source !== lift + ".work" && target !== lift + ".work")
  )
    throw new Error("Invalid transfer endpoints");
  return { material: f.material, source, target, request: r };
}
export class LiftSceneAdapter extends WarehouseActionAdapter {
  transfer?: MaterialTransferService;
  constructor(
    scene: string,
    run: string,
    mount: RailMountedLift,
    config: WarehouseConfig,
    physics: PhysicsPort,
    lifecycle: TransferLifecycle,
  ) {
    let setTransfer: (s: MaterialTransferService) => void = () => {};
    super(
      mount.config.lift,
      scene,
      run,
      [
        "accept_material",
        "release_material",
        "transfer_material",
        "lift_to_location",
        "lift_to_level",
        "hold_lift",
      ],
      (r) => {
        if (
          ["lift_to_location", "lift_to_level", "hold_lift"].includes(
            r.behavior,
          )
        ) {
          const stop = r.behavior === "hold_lift",
            l = config.locations.get(String(r.arguments.target));
          // Existing numeric height is relative to the device base; compiled rest anchor/base offset is explicit.
          const target = stop
            ? mount.lift.position
            : r.behavior === "lift_to_location"
              ? l
                ? resolveDock(mount.config, l).lift
                : NaN
              : Number(
                  (r.arguments.move_to_level as { value: number })?.value,
                ) - mount.config.restHeight;
          if (
            !Number.isFinite(target) ||
            target < mount.config.liftLimits[0] ||
            target > mount.config.liftLimits[1]
          )
            throw new Error("Invalid lift target");
          return axisJob(
            mount.lift,
            target,
            stop,
            () => mount.move("lift", target),
            () => mount.at("lift", target),
            () => mount.stop(),
          );
        }
        const t = transferFields(mount.config.lift, r);
        lifecycle.validate(t);
        const m = config.materials.get(t.material),
          source = config.locations.get(t.source),
          target = config.locations.get(t.target);
        if (!m || !source || !target)
          throw new Error("Missing transfer entity");
        if (
          !mount.config.routes.some(
            (route) =>
              route.sources.includes(t.source) &&
              route.targets.includes(t.target),
          )
        )
          throw new Error("Transfer route not declared");
        const point = (l: WarehouseLocation) =>
          new Vector3(
            ...(l.kind === "platform" ? mount.anchor : l.position),
          ).add(new Vector3(0, m.size[1] / 2, 0));
        const actual = physics.readBody!(m.body);
        if (
          !physics.hasSupport(m.body, source.support) ||
          new Vector3(...actual.position).distanceTo(point(source)) > 0.04 ||
          Math.hypot(...actual.velocity) > 0.03
        )
          throw new Error("Source load not settled at endpoint");
        if (target.kind !== "platform") {
          const dock = resolveDock(mount.config, target);
          if (!mount.at("rail", dock.rail) || !mount.at("lift", dock.lift))
            throw new Error("Platform not aligned to destination");
        } else {
          const dock = resolveDock(mount.config, source);
          if (!mount.at("rail", dock.rail) || !mount.at("lift", dock.lift))
            throw new Error("Platform not aligned to source");
        }
        const service = new MaterialTransferService(
          `${run}/${r.requestId}`,
          t.material,
          m.body,
          { location: target, position: point(target).toArray() },
          mount,
          physics,
          (tick) => lifecycle.commit(t, tick),
        );
        return {
          begin: () => {
            lifecycle.begin(t);
            service.begin();
            setTransfer(service);
          },
          before: (dt) => service.beforePhysics(dt),
          after: (tick) => service.afterPhysics(tick),
          cancel: () => service.stop(),
          complete: () => service.committed,
          stopped: () => service.stopped,
        };
      },
      () => mount.stopped,
      () => ({
        actual_height: mount.config.restHeight + mount.actual("lift"),
        moving: Math.abs(mount.lift.velocity) > 0.001,
        at_level: mount.lift.settled,
      }),
    );
    setTransfer = (s) => {
      this.transfer = s;
    };
  }
}

export interface TransferEndpoint {
  location: WarehouseLocation;
  position: [number, number, number];
}
/** One material identity survives every transfer. No material position setter is used. */
export class MaterialTransferService {
  readonly constraint: string;
  private trajectory: LinearAxisTrajectory;
  private start: BodyPose;
  private direction: Vector3;
  private released = false;
  private settledTicks = 0;
  committed = false;
  cancelled = false;
  constructor(
    readonly request: string,
    readonly material: string,
    readonly body: string,
    readonly target: TransferEndpoint,
    readonly mount: RailMountedLift,
    private physics: PhysicsPort,
    private onCommit: (tick: number) => void,
  ) {
    this.target = structuredClone(target);
    this.start = physics.readBody!(body);
    this.direction = new Vector3(...target.position).sub(
      new Vector3(...this.start.position),
    );
    const length = this.direction.length();
    this.direction.normalize();
    if (length > mount.config.maxTransfer || !mount.stopped)
      throw new Error(
        "Virtual transfer exceeds permitted distance or axes busy",
      );
    this.constraint = mount.config.lift + "/transfer/" + request;
    this.trajectory = new LinearAxisTrajectory(
      0,
      mount.config.transferSpeed,
      mount.config.transferAccel,
      [0, Math.max(length + 0.1, 0.1)],
    );
    this.trajectory.command(length);
  }
  begin() {
    this.physics.placeEmptyTool!(this.mount.config.tool, this.start);
    this.physics.createGrasp!(
      this.constraint,
      this.mount.config.tool,
      this.body,
    );
    this.mount.transferring = true;
    this.mount.held = undefined;
  }
  beforePhysics(dt: number) {
    this.trajectory.step(dt);
    const position = new Vector3(...this.start.position)
      .addScaledVector(this.direction, this.trajectory.position)
      .toArray();
    if (!this.released)
      this.physics.moveTool!(
        this.mount.config.tool,
        { ...this.start, position },
        dt,
      );
  }
  afterPhysics(tick: number) {
    if (this.cancelled || this.committed) return;
    const p = this.physics.readBody!(this.body),
      error = new Vector3(...p.position).distanceTo(
        new Vector3(...this.target.position),
      );
    if (
      !this.released &&
      this.trajectory.settled &&
      error < 0.015 &&
      Math.hypot(...p.velocity) < 0.03
    ) {
      this.physics.removeGrasp!(this.constraint);
      this.released = true;
    }
    if (
      this.released &&
      error < 0.02 &&
      Math.hypot(...p.velocity) < 0.03 &&
      this.physics.hasContactSupport!(this.body, this.target.location.support)
    ) {
      if (++this.settledTicks >= 4) {
        if (this.target.location.kind === "platform") {
          this.physics.bindLoad!(this.target.location.support, this.body);
          this.mount.held = this.material;
        }
        this.onCommit(tick);
        this.mount.transferring = false;
        this.committed = true;
      }
    } else this.settledTicks = 0;
  }
  stop() {
    this.cancelled = true;
    this.trajectory.stop();
  }
  get stopped() {
    return this
      .committed; /* In-flight material needs explicit attention, even after physical braking. */
  }
  snapshot() {
    return {
      material: this.material,
      target: this.target.location.id,
      phase: this.committed
        ? "committed"
        : this.cancelled
          ? "stopping"
          : this.released
            ? "settling"
            : "transferring",
      holding: this.physics.hasGrasp!(this.constraint),
    };
  }
}

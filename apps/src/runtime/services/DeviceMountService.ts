/** 组合滑轨和升降轴的运动，更新移动部件与承载点的物理位姿，检查到位状态及带载路径上的障碍物。 */

import { Vector3 } from "three";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import type { WarehouseAssembly } from "@/contracts/warehouse";
import { LinearAxisTrajectory } from "@/runtime/mechanisms/LinearAxisTrajectory";
import { sweptLoadBlocker } from "@/domain/runtime/warehouseClearance";
import type { RuntimeBody } from "@/contracts/physics";
export class DeviceMountService {
  readonly rail: LinearAxisTrajectory;
  readonly lift: LinearAxisTrajectory;
  transferring = false;
  held?: string;
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
    this.mastRest = physics.readBody!(config.mast);
    this.platformRest = physics.readBody!(config.platform);
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
    this.rail.step(dt);
    this.lift.step(dt);
    const r = new Vector3(...this.config.axis).multiplyScalar(
        this.rail.position,
      ),
      l = new Vector3(...this.config.vertical).multiplyScalar(
        this.lift.position,
      );
    this.physics.moveKinematicBody!(
      this.config.mast,
      {
        ...this.mastRest,
        position: new Vector3(...this.mastRest.position).add(r).toArray(),
      },
      dt,
    );
    this.physics.moveKinematicBody!(
      this.config.platform,
      {
        ...this.platformRest,
        position: new Vector3(...this.platformRest.position)
          .add(r)
          .add(l)
          .toArray(),
      },
      dt,
    );
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

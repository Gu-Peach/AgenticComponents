/** 用临时抓取约束沿直线移动同一物料，抵达目标后释放并检查实际支承。交接到升降台时将物料绑定到平台。 */

import { Vector3 } from "three";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import type { WarehouseLocation } from "@/contracts/warehouse";
import type { DeviceMountService } from "./DeviceMountService";
import { LinearAxisTrajectory } from "@/runtime/mechanisms/LinearAxisTrajectory";
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
    readonly mount: DeviceMountService,
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

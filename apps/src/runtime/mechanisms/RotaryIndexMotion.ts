import { Quaternion, Vector3 } from "three";
import type { PhysicsPort, Vec3 } from "@/contracts/physics";
import type { WarehouseJob } from "@/runtime/adapters/scene/WarehouseActionAdapter";
import { LinearAxisTrajectory } from "./LinearAxisTrajectory";

const rad = Math.PI / 180;
const normalAngle = (angle: number) => ((angle % 360) + 360) % 360;

/** Index forward to an absolute station angle. The support and its fixed load turn about the declared pivot. */
export class RotaryIndexMotion {
  phase = "idle";
  private readonly motion: LinearAxisTrajectory;
  private readonly rotation: Quaternion;
  private readonly origin: Vector3;
  private readonly center: Vector3;
  private readonly axis: Vector3;

  constructor(
    private physics: PhysicsPort,
    readonly body: string,
    pivot: Vec3,
    axis: Vec3,
    speed: number,
    acceleration: number,
    private angleTolerance: number,
    private settleSpeed: number,
  ) {
    const initial = physics.readBody!(body);
    this.center = new Vector3(...pivot);
    this.origin = new Vector3(...initial.position).sub(this.center);
    this.axis = new Vector3(...axis).normalize();
    this.rotation = new Quaternion(...initial.rotation);
    this.motion = new LinearAxisTrajectory(0, speed, acceleration, [
      -Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ]);
  }
  get angleDeg() {
    return this.motion.position;
  }
  get measuredAngleDeg() {
    const pose = this.physics.readBody!(this.body);
    const relative = new Quaternion(...pose.rotation).multiply(
      this.rotation.clone().invert(),
    );
    const twist = new Vector3(relative.x, relative.y, relative.z).dot(
      this.axis,
    );
    return normalAngle((2 * Math.atan2(twist, relative.w)) / rad);
  }
  get stopped() {
    const p = this.physics.readBody!(this.body);
    return (
      Math.abs(this.motion.velocity) <= this.settleSpeed &&
      Math.hypot(...(p.angularVelocity ?? [])) <= this.settleSpeed * rad
    );
  }
  at(angle: number) {
    const pose = this.physics.readBody!(this.body);
    const expected = new Quaternion()
      .setFromAxisAngle(this.axis, angle * rad)
      .multiply(this.rotation);
    return (
      this.stopped &&
      expected.angleTo(new Quaternion(...pose.rotation)) <=
        this.angleTolerance * rad
    );
  }
  slot(offset: Vec3) {
    const measured = this.physics.readBody!(this.body);
    const delta = new Quaternion(...measured.rotation).multiply(
      this.rotation.clone().invert(),
    );
    return new Vector3(...offset)
      .sub(this.origin)
      .applyQuaternion(delta)
      .add(new Vector3(...measured.position));
  }
  job(
    target: number,
    retained: () => boolean,
    complete: (tick: number, from: number, to: number) => void,
  ): WarehouseJob {
    const from = this.motion.target;
    const turn = normalAngle(target - normalAngle(from));
    if (turn <= this.angleTolerance)
      throw new Error("Rotary table already at requested station");
    const to = from + turn;
    let settledSamples = 0;
    let done = false,
      cancelled = false;
    return {
      begin: () => {
        this.motion.command(to);
        this.phase = "index";
      },
      before: (dt) => {
        this.motion.step(dt);
        if (!cancelled && this.motion.settled) {
          this.motion.position = to;
          this.motion.velocity = 0;
        }
        const delta = new Quaternion().setFromAxisAngle(
          this.axis,
          this.angleDeg * rad,
        );
        this.physics.moveKinematicBody!(
          this.body,
          {
            position: this.origin
              .clone()
              .applyQuaternion(delta)
              .add(this.center)
              .toArray(),
            rotation: delta.multiply(this.rotation).toArray(),
            velocity: [0, 0, 0],
          },
          dt,
        );
      },
      after: (tick) => {
        if (cancelled) return;
        if (!retained())
          throw new Error("Rotary table lost its indexed load or interlock");
        // A second command at the same final pose removes the last interpolation velocity in Jolt.
        settledSamples =
          this.motion.settled && this.at(target) ? settledSamples + 1 : 0;
        if (settledSamples >= 2) {
          done = true;
          this.phase = "idle";
          complete(tick, from, to);
        }
      },
      cancel: () => {
        cancelled = true;
        this.motion.stop();
        this.phase = "stopped";
      },
      stopped: () => this.stopped,
      complete: () => done,
    };
  }
}

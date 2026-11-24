/** 驱动转台绕指定轴正向分度，持续检查载荷保持与运动互锁，并依据实测角度和停稳状态确认到站。 */

import { Quaternion, Vector3 } from "three";
import type { PhysicsPort, Vec3 } from "@/contracts/physics";
import type { ActionRequest } from "@/contracts/scheduler";
import type { SceneSignalFrame, SignalWrite } from "@/contracts/scene-signals";
import {
  WarehouseActionAdapter,
  type WarehouseJob,
} from "@/runtime/adapters/scene/WarehouseActionAdapter";
import { LinearAxisTrajectory } from "@/runtime/mechanisms/LinearAxisTrajectory";

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
    private readonly restAngle = 0,
  ) {
    const initial = physics.readBody!(body);
    this.center = new Vector3(...pivot);
    this.origin = new Vector3(...initial.position).sub(this.center);
    this.axis = new Vector3(...axis).normalize();
    this.rotation = new Quaternion(...initial.rotation);
    this.motion = new LinearAxisTrajectory(restAngle, speed, acceleration, [
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
    return normalAngle(
      this.restAngle + (2 * Math.atan2(twist, relative.w)) / rad,
    );
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
      .setFromAxisAngle(this.axis, (angle - this.restAngle) * rad)
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
    // Repeated absolute setpoints still require measured settling and load feedback.
    const to = this.at(target) ? from : from + turn;
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
          (this.angleDeg - this.restAngle) * rad,
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

/** 分度请求同时发布目标角与执行信号，保留本轮请求与激活身份。 */
export class TableIndexAdapter extends WarehouseActionAdapter {
  constructor(
    sceneId: string,
    runId: string,
    id: string,
    plan: (request: ActionRequest) => WarehouseJob,
    stopped: () => boolean,
    state: () => { angle: number; occupied: boolean },
    private stations: readonly number[],
    tolerance: number,
  ) {
    super(
      id,
      sceneId,
      runId,
      ["rotate_to_station"],
      plan,
      stopped,
      () => {
        const { angle, occupied } = state();
        const rotating = !stopped();
        const atStation = stations.some(
          (target) =>
            Math.abs(normalAngle(angle - target + 180) - 180) <= tolerance,
        );
        return {
          actual_angle: angle,
          occupied,
          rotating,
          at_station: !rotating && atStation,
        };
      },
      "rotate_to_station",
    );
  }
  override prepare(
    request: ActionRequest,
    frame: Readonly<SceneSignalFrame>,
  ): SignalWrite[] {
    const target = request.arguments.angleTag as
      { unit?: string; value?: number } | undefined;
    if (
      target?.unit !== "°" ||
      typeof target.value !== "number" ||
      !this.stations.includes(target.value)
    )
      throw new Error("Indexing request requires a configured station");
    return [
      ...super.prepare(request, frame),
      {
        key: this.sceneId + "/" + this.id + "/angleTag",
        writer: "process",
        runId: request.runId,
        requestId: request.requestId,
        activationId: request.activationId,
        subjectId: request.subjectId,
        value: target.value,
      },
    ];
  }
}

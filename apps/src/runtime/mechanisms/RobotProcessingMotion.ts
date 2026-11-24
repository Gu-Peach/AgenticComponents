import { Quaternion, Vector3 } from "three";
import type { WarehouseJob } from "@/runtime/adapters/scene/WarehouseActionAdapter";
import type { HandoffArm } from "@/runtime/services/HandoffMotion";

export interface ProcessContact {
  position: Vector3;
  outward: Vector3;
}
export interface ProcessEvidence {
  startTick: number;
  endTick: number;
  dwellTicks: number;
  maxPositionError: number;
  maxAngleErrorDeg: number;
}

/** Approach the named material port, maintain physical TCP alignment for the cycle, then retreat. */
export class RobotProcessingMotion {
  phase = "idle";
  alignment: { positionError: number; angleErrorDeg: number } | null = null;
  constructor(
    readonly arm: HandoffArm,
    private duration: number,
    private positionTolerance: number,
    private angleTolerance: number,
  ) {}

  private path(contact: ProcessContact) {
    const toward = contact.outward.clone().negate();
    const approach = contact.position
      .clone()
      .addScaledVector(contact.outward, this.arm.scene.liftHeight);
    for (const roll of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const rotation: Quaternion = this.arm.rotationFacing(toward, roll);
      const near = this.arm.solve(approach, rotation);
      const touch = near && this.arm.solve(contact.position, rotation, near);
      if (near && touch) return { near, touch };
    }
    throw new Error(
      "Processing TCP cannot reach the declared workpiece interface with its required approach direction",
    );
  }
  private measure(contact: ProcessContact) {
    const pose = this.arm.pose;
    const direction = this.arm.axis
      .clone()
      .applyQuaternion(new Quaternion(...pose.rotation));
    return {
      positionError: new Vector3(...pose.position).distanceTo(contact.position),
      angleErrorDeg:
        (direction.angleTo(contact.outward.clone().negate()) * 180) / Math.PI,
    };
  }
  job(
    contact: () => ProcessContact,
    interlocked: () => boolean,
    complete: (tick: number, evidence: ProcessEvidence) => void,
  ): WarehouseJob {
    const path = this.path(contact());
    let elapsed = 0,
      done = false,
      cancelled = false,
      dt = 0;
    const evidence: ProcessEvidence = {
      startTick: 0,
      endTick: 0,
      dwellTicks: 0,
      maxPositionError: 0,
      maxAngleErrorDeg: 0,
    };
    return {
      begin: () => {
        this.phase = "approach";
        this.alignment = null;
        this.arm.start([path.near, path.touch]);
      },
      before: (step) => {
        dt = step;
        this.arm.step(step);
      },
      after: (tick) => {
        if (cancelled) return;
        if (!interlocked())
          throw new Error("Indexed workpiece moved during processing");
        if (!this.arm.stopped) {
          if (this.phase === "process")
            throw new Error("Processing TCP moved during the dwell interval");
          return;
        }
        if (this.phase === "approach" || this.phase === "process") {
          this.alignment = this.measure(contact());
          const { positionError, angleErrorDeg } = this.alignment;
          if (
            positionError > this.positionTolerance ||
            angleErrorDeg > this.angleTolerance
          )
            throw new Error(
              `Tool/workpiece processing port error: ${positionError.toFixed(4)} m, ${angleErrorDeg.toFixed(2)} degrees`,
            );
          this.phase = "process";
          if (evidence.dwellTicks === 0) evidence.startTick = tick;
          evidence.endTick = tick;
          evidence.dwellTicks++;
          evidence.maxPositionError = Math.max(
            evidence.maxPositionError,
            positionError,
          );
          evidence.maxAngleErrorDeg = Math.max(
            evidence.maxAngleErrorDeg,
            angleErrorDeg,
          );
          elapsed += dt;
          if (elapsed + 1e-9 >= this.duration) {
            this.phase = "retreat";
            this.arm.start([path.near, this.arm.q.map(() => 0)]);
          }
        } else if (this.phase === "retreat" && this.arm.atHome) {
          this.phase = "idle";
          done = true;
          complete(tick, evidence);
        }
      },
      cancel: () => {
        cancelled = true;
        this.phase = "stopped";
        this.arm.stop();
      },
      stopped: () => this.arm.stopped,
      complete: () => done,
    };
  }
}

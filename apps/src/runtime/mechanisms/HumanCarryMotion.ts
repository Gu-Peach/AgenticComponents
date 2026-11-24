/** 驱动人物接近工件、吸附搬运和放置，确认工件得到支承后撤回。人体随手部水平移动。 */

import { Vector3 } from "three";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import type { WarehouseJob } from "@/runtime/adapters/scene/WarehouseActionAdapter";

interface CarryPlan {
  material: string;
  body: string;
  source: () => Vector3;
  destination: Vector3;
  /** The handle is carried with a fixed orientation for this translation. */
  handleOffset: Vector3;
  sourceReady(): boolean;
  captured(): void;
  receiverReady(): boolean;
  placed(): boolean;
  accept(): void;
  complete(tick: number): void;
}

/** A grounded avatar follows the wrist horizontally. The suction point can lift a load. */
export class HumanCarryMotion {
  readonly grip: string;
  readonly handHome: BodyPose;
  readonly bodyHome: BodyPose;
  phase = "idle";
  holding: string | null = null;
  private target: Vector3;

  constructor(
    private physics: PhysicsPort,
    private body: string,
    private hand: string,
    private speed: number,
    private lift: number,
    private tolerance: number,
  ) {
    this.handHome = physics.readBody!(hand);
    this.bodyHome = physics.readBody!(body);
    this.target = new Vector3(...this.handHome.position);
    this.grip = this.hand + "/suction";
  }

  get stopped() {
    const p = this.physics.readBody!(this.hand);
    return (
      Math.hypot(...p.velocity) < 0.015 &&
      new Vector3(...p.position).distanceTo(this.target) < this.tolerance
    );
  }
  get atHome() {
    return (
      this.stopped &&
      !this.holding &&
      this.target.distanceTo(new Vector3(...this.handHome.position)) <
        this.tolerance
    );
  }
  private step(dt: number) {
    const p = this.physics.readBody!(this.hand);
    const hand = new Vector3(...p.position);
    const delta = this.target.clone().sub(hand);
    hand.add(delta.clampLength(0, this.speed * dt));
    this.physics.moveTool!(this.hand, { ...p, position: hand.toArray() }, dt);
    const body = new Vector3(...this.bodyHome.position);
    body.x += hand.x - this.handHome.position[0];
    body.z += hand.z - this.handHome.position[2];
    this.physics.moveTool!(
      this.body,
      { ...this.bodyHome, position: body.toArray() },
      dt,
    );
  }

  job(plan: CarryPlan): WarehouseJob {
    const source = plan.source();
    // Drop through the small clearance onto the declared receiver and wait for real contact.
    const landing = plan.destination
      .clone()
      .add(plan.handleOffset)
      .add(new Vector3(0, 0.004, 0));
    const safeY =
      Math.max(source.y, landing.y, this.handHome.position[1]) + this.lift;
    const above = (p: Vector3) => new Vector3(p.x, safeY, p.z);
    let done = false,
      cancelled = false;
    const go = (phase: string, target: Vector3) => {
      this.phase = phase;
      this.target = target;
    };
    return {
      begin: () => go("approach", above(source)),
      before: (dt) => this.step(dt),
      after: (tick) => {
        if (cancelled) return;
        if (this.holding) {
          const wrist = new Vector3(
            ...this.physics.readBody!(this.hand).position,
          );
          if (
            !this.physics.hasGrasp!(this.grip) ||
            wrist.distanceTo(plan.source()) > this.tolerance
          )
            throw new Error("Human suction lost its workpiece handle");
        }
        if (!this.stopped) return;
        switch (this.phase) {
          case "approach":
            go("capture", source);
            break;
          case "capture": {
            const wrist = new Vector3(
              ...this.physics.readBody!(this.hand).position,
            );
            if (
              !plan.sourceReady() ||
              wrist.distanceTo(plan.source()) > this.tolerance
            )
              throw new Error("Workpiece is outside the suction interface");
            this.physics.createGrasp!(this.grip, this.hand, plan.body);
            this.holding = plan.material;
            plan.captured();
            go("lift", above(source));
            break;
          }
          case "lift":
            go("carry", above(landing));
            break;
          case "carry":
            go("lower", landing);
            break;
          case "lower": {
            const pose = this.physics.readBody!(plan.body);
            if (
              !plan.receiverReady() ||
              new Vector3(...pose.position).distanceTo(plan.destination) >
                this.tolerance
            )
              throw new Error("Carried workpiece does not match its receiver");
            this.physics.removeGrasp!(this.grip);
            this.holding = null;
            this.phase = "settle";
            break;
          }
          case "settle":
            if (plan.placed()) {
              plan.accept();
              go("withdraw", above(landing));
            }
            break;
          case "withdraw":
            go("home", new Vector3(...this.handHome.position));
            break;
          case "home":
            if (!plan.placed())
              throw new Error("Released workpiece left its receiver");
            plan.complete(tick);
            this.phase = "idle";
            done = true;
            break;
        }
      },
      cancel: () => {
        cancelled = true;
        this.target = new Vector3(
          ...this.physics.readBody!(this.hand).position,
        );
        this.phase = "stopped";
      },
      stopped: () => this.stopped,
      complete: () => done,
    };
  }
}

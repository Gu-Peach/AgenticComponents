/** Phase owner for a shared physical world; adapters must never step or dispose it. */
export interface SceneWorld {
  isMotionStopped?(): boolean;
  step(dt: number): void;
  dispose(): void;
}
export interface SceneDeviceDriver {
  id: string;
  beforePhysics(dt: number, tick: number): void;
  afterPhysics(dt: number, tick: number): void;
  requestStop(): void;
  isStopped(): boolean;
  dispose(): void;
}
export class SceneWorldStepper {
  private tick = 0;
  private state:
    | "ready"
    | "running"
    | "paused"
    | "stopping"
    | "stopped"
    | "attention_required"
    | "disposed" = "ready";
  private stopTicks = 0;
  private failure: string | null = null;
  constructor(
    private world: SceneWorld,
    private drivers: SceneDeviceDriver[],
    private stopLimit = 1800,
  ) {
    if (new Set(drivers.map((d) => d.id)).size !== drivers.length)
      throw new Error("Duplicate driver");
    if (!Number.isInteger(stopLimit) || stopLimit < 1)
      throw new Error("Invalid stop deadline");
  }
  start() {
    if (this.state !== "ready") throw new Error("Session is not ready");
    this.state = "running";
  }
  pause() {
    if (this.state === "running") this.state = "paused";
  }
  resume() {
    if (this.state === "paused") this.state = "running";
  }
  stop() {
    if (!["running", "paused", "ready"].includes(this.state)) return;
    this.state = "stopping";
    for (const d of this.drivers)
      try {
        d.requestStop();
      } catch (e) {
        this.failure = String(e);
        this.state = "attention_required";
      }
  }
  step(dt: number) {
    if (!Number.isFinite(dt) || Math.abs(dt - 1 / 60) > 1e-8)
      throw new Error("Only fixed 1/60 steps are supported");
    if (this.state !== "running" && this.state !== "stopping")
      return this.snapshot();
    try {
      const tick = this.tick + 1;
      for (const d of this.drivers) d.beforePhysics(dt, tick);
      this.world.step(dt);
      this.tick = tick;
      for (const d of this.drivers) d.afterPhysics(dt, tick);
      if (this.state === "stopping") {
        if (this.drivers.every((d) => d.isStopped())) this.state = "stopped";
        else if (++this.stopTicks >= this.stopLimit) {
          this.state = "attention_required";
          this.failure = "Physical stop was not confirmed";
        }
      }
    } catch (e) {
      this.failure = String(e);
      for (const d of this.drivers)
        try {
          d.requestStop();
        } catch {
          /* Preserve the original error. */
        }
      this.state = "attention_required";
    }
    return this.snapshot();
  }
  snapshot() {
    return { tick: this.tick, status: this.state, error: this.failure };
  }
  dispose() {
    if (this.state === "disposed") return;
    if (!["ready", "stopped"].includes(this.state))
      throw new Error("Cannot dispose an unconfirmed moving world");
    try {
      for (const d of this.drivers) d.dispose();
    } finally {
      this.world.dispose();
      this.state = "disposed";
    }
  }
  /** Explicitly abandon a quiescent failed simulation, without a successful handoff receipt. */
  discard() {
    if (
      this.state !== "attention_required" ||
      this.world.isMotionStopped?.() !== true
    )
      throw new Error(
        "Only a physically stopped faulted simulation can be discarded",
      );
    try {
      for (const d of this.drivers) d.dispose();
    } finally {
      this.world.dispose();
      this.state = "disposed";
    }
  }
}

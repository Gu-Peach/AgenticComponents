import type { RuntimeSnapshot } from "@/contracts/runtime";
import { RuntimeKernel } from "./RuntimeKernel";
export class SimulationSession {
  private state: RuntimeSnapshot["status"] = "ready";
  constructor(readonly kernel: RuntimeKernel) {}
  start() {
    this.state = "running";
  }
  pause() {
    if (this.state === "running") this.state = "paused";
  }
  resume() {
    if (this.state === "paused") this.state = "running";
  }
  step(dt: number) {
    if (this.state === "running") this.kernel.step(dt);
    return this.snapshot();
  }
  snapshot() {
    return { ...this.kernel.snapshot(), status: this.state };
  }
  stop() {
    if (this.state !== "stopped") {
      this.kernel.stop();
      this.state = "stopped";
    }
    return this.snapshot();
  }
}

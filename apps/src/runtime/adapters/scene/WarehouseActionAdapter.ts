import type { ActionRequest, ActionFeedback } from "@/contracts/scheduler";
import type { SceneSignalFrame, SignalWrite } from "@/contracts/scene-signals";
import type { DeviceActionPort } from "./DeviceActionPort";
export interface WarehouseJob {
  begin(): void;
  before(dt: number): void;
  after(tick: number): void;
  cancel(): void;
  complete(): boolean;
  stopped(): boolean;
}
/** Shared request protocol only; device mechanics live in independent modules. */
export class WarehouseActionAdapter implements DeviceActionPort {
  request?: ActionRequest;
  job?: WarehouseJob;
  state: "idle" | "running" | "succeeded" | "stopped" | "failed" = "idle";
  error?: string;
  private prepared?: { request: ActionRequest; job: WarehouseJob };
  private feedback: ActionFeedback[] = [];
  private signals: SignalWrite[] = [];
  private stopping = false;
  private accepted = false;
  constructor(
    readonly id: string,
    readonly sceneId: string,
    readonly runId: string,
    private behaviors: readonly string[],
    private plan: (r: ActionRequest) => WarehouseJob,
    private physicalStopped: () => boolean,
    private extraSignals: (
      faulted: boolean,
    ) => Record<string, number | boolean> = () => ({}),
    private trigger = "execute",
  ) {}
  supports(b: string) {
    return this.behaviors.includes(b);
  }
  private write(
    port: string,
    value: number | boolean,
    writer = "process",
    request = this.request,
  ): SignalWrite {
    return {
      key: `${this.sceneId}/${this.id}/${port}`,
      writer,
      runId: this.runId,
      value,
      requestId: request?.requestId,
      activationId: request?.activationId,
      subjectId: request?.subjectId,
    };
  }
  prepare(r: ActionRequest, frame: Readonly<SceneSignalFrame>) {
    if (
      r.runId !== this.runId ||
      frame.runId !== this.runId ||
      r.device !== this.id ||
      !this.supports(r.behavior) ||
      this.state === "running" ||
      this.stopping ||
      !this.physicalStopped()
    )
      throw new Error("Device request not admissible");
    this.prepared = { request: r, job: this.plan(r) };
    return [
      this.write(this.trigger, true, "process", r),
      this.write("request_id", Number(r.requestId), "process", r),
    ];
  }
  submit(r: ActionRequest) {
    if (this.prepared?.request !== r) throw new Error("Unprepared request");
    this.request = r;
    this.job = this.prepared.job;
    this.prepared = undefined;
    this.state = "running";
    this.accepted = false;
    this.job.begin();
  }
  prepareCancel() {
    return [this.write(this.trigger, false)];
  }
  prepareStop() {
    return [this.write(this.trigger, false)];
  }
  acknowledge() {
    return [this.write(this.trigger, false)];
  }
  cancel(r: ActionRequest) {
    if (r.requestId !== this.request?.requestId || r.runId !== this.runId)
      throw new Error("Foreign cancellation");
    this.requestStop();
  }
  requestStop() {
    this.stopping = true;
    this.job?.cancel();
  }
  isStopped() {
    return this.physicalStopped() && (!this.job || this.job.stopped());
  }
  beforePhysics(dt: number) {
    if (this.request && !this.accepted && this.state === "running") {
      this.feedback.push({ ...this.request, status: "accepted" });
      this.accepted = true;
    }
    if (this.job && (this.state === "running" || this.stopping))
      this.job.before(dt);
  }
  afterPhysics(_dt: number, tick: number) {
    if (this.request && this.job) {
      if (this.stopping && this.isStopped()) {
        if (this.state !== "stopped") {
          this.state = "stopped";
          this.feedback.push({ ...this.request, status: "stopped" });
        }
      } else if (this.state === "running" && this.job.complete()) {
        this.state = "succeeded";
        this.feedback.push({ ...this.request, status: "succeeded" });
      } else if (this.state === "running") {
        try {
          this.job.after(tick);
        } catch (e) {
          this.error = String(e);
          this.state = "failed";
          this.job.cancel();
          this.feedback.push({
            ...this.request,
            status: "failed",
            reason: this.error,
          });
        }
        if (!this.stopping && this.state === "running" && this.job.complete()) {
          this.state = "succeeded";
          this.feedback.push({ ...this.request, status: "succeeded" });
        }
      }
    }
    for (const [port, value] of Object.entries({
      accepted: this.accepted,
      busy: this.state === "running",
      done: this.state === "succeeded",
      error: !!this.error,
      result_id: Number(this.request?.requestId ?? 0),
      ...this.extraSignals(Boolean(this.error)),
    }))
      this.signals.push(this.write(port, value, "adapter:" + this.id));
  }
  drainFeedback() {
    const v = this.feedback;
    this.feedback = [];
    return v;
  }
  drainSignals() {
    const v = this.signals;
    this.signals = [];
    return v;
  }
  dispose() {}
  snapshot() {
    return {
      request: this.request,
      state: this.state,
      stopped: this.isStopped(),
      error: this.error,
    };
  }
}

/** 实现多个设备共用的有限动作请求协议，驱动具体任务的开始、逐步执行和取消，并发布与请求号对应的 PLC 信号和结果。 */

import type { ActionRequest, ActionFeedback } from "@/contracts/scheduler";
import type { SceneSignalFrame, SignalWrite } from "@/contracts/scene-signals";
import type { DeviceActionPort } from "./DeviceActionPort";
import { DeviceRequestLatch } from "@/runtime/engine/DeviceRequestLatch";
import { immutable } from "@/runtime/scheduler/expressions";
export interface WarehouseJob {
  begin(): void;
  before(dt: number): void;
  after(tick: number): void;
  cancel(): void;
  complete(): boolean;
  stopped(): boolean;
  /** True only when the cause of this job's fault has actually cleared. */
  canResetFault?(): boolean;
}
/** Shared request protocol only; device mechanics live in independent modules. */
export class WarehouseActionAdapter implements DeviceActionPort {
  request?: ActionRequest;
  job?: WarehouseJob;
  state: "idle" | "running" | "succeeded" | "stopped" | "failed" = "idle";
  error?: string;
  private prepared?: {
    source: ActionRequest;
    frozen: ActionRequest;
    job: WarehouseJob;
  };
  private readonly latch: DeviceRequestLatch;
  private hasFaultCodePort = false;
  private resetHigh = false;
  private feedback: ActionFeedback[] = [];
  private signals: SignalWrite[] = [];
  private stopping = false;
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
    private onSucceeded?: (request: ActionRequest) => void,
  ) {
    this.latch = new DeviceRequestLatch(sceneId, runId, id, trigger);
  }
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
  sampleInputs(frame: Readonly<SceneSignalFrame>) {
    this.latch.sample(frame);
    const prefix = this.sceneId + "/" + this.id + "/";
    this.hasFaultCodePort =
      frame.samples[prefix + "error_code"]?.writer === "adapter:" + this.id;
    const reset = frame.samples[prefix + "reset"];
    const high = reset?.quality === "good" && reset.value === true;
    if (
      high &&
      !this.resetHigh &&
      this.error &&
      !this.stopping &&
      this.physicalStopped() &&
      this.job?.stopped() &&
      this.job.canResetFault?.()
    ) {
      this.error = undefined;
      this.state = "idle";
    }
    this.resetHigh = high;
  }
  prepare(r: ActionRequest, frame: Readonly<SceneSignalFrame>) {
    this.latch.check(r, frame);
    if (
      !this.supports(r.behavior) ||
      this.error ||
      this.state === "running" ||
      this.stopping ||
      !this.physicalStopped()
    )
      throw new Error("Device request not admissible");
    const frozen = immutable(structuredClone(r));
    this.prepared = { source: r, frozen, job: this.plan(frozen) };
    return [
      this.write(this.trigger, true, "process", r),
      this.write("request_id", Number(r.requestId), "process", r),
    ];
  }
  submit(r: ActionRequest) {
    if (this.prepared?.source !== r) throw new Error("Unprepared request");
    this.request = this.prepared.frozen;
    this.latch.submit(this.request);
    this.job = this.prepared.job;
    this.prepared = undefined;
    this.state = "running";
  }
  prepareCancel() {
    return [this.write(this.trigger, false)];
  }
  prepareStop() {
    return [this.write(this.trigger, false)];
  }
  acknowledge(feedback: ActionFeedback, frame: Readonly<SceneSignalFrame>) {
    return this.latch.acknowledge(feedback, frame);
  }
  cancel(r: ActionRequest) {
    if (!this.latch.matches(r)) throw new Error("Foreign cancellation");
    this.requestStop();
  }
  requestStop() {
    if (this.stopping) return;
    this.stopping = true;
    this.job?.cancel();
  }
  isStopped() {
    return this.physicalStopped() && (!this.job || this.job.stopped());
  }
  beforePhysics(dt: number) {
    try {
      const accepted =
        !this.stopping && this.state === "running" && this.latch.accept();
      if (accepted) {
        this.feedback.push(accepted);
        this.job!.begin();
      }
      if (this.job && (this.state === "running" || this.stopping))
        this.job.before(dt);
    } catch (error) {
      this.fail(error);
    }
  }
  private fail(error: unknown) {
    if (!this.request || !this.job) throw error;
    this.error = String(error);
    this.state = "failed";
    this.latch.finish(false);
    this.job.cancel();
    this.feedback.push({
      ...this.request,
      status: "failed",
      reason: this.error,
    });
  }
  afterPhysics(_dt: number, tick: number) {
    if (this.request && this.job) {
      if (this.stopping && this.isStopped()) {
        if (this.state !== "stopped") {
          this.state = "stopped";
          this.feedback.push({ ...this.request, status: "stopped" });
        }
      } else if (
        !this.stopping &&
        this.state === "running" &&
        !this.latch.awaitingAcceptance
      ) {
        try {
          if (!this.job.complete()) this.job.after(tick);
          if (this.state === "running" && this.job.complete()) {
            this.onSucceeded?.(this.request);
            this.state = "succeeded";
            this.latch.finish(true);
            this.feedback.push({ ...this.request, status: "succeeded" });
          }
        } catch (error) {
          this.fail(error);
        }
      }
    }
    const writer = "adapter:" + this.id;
    const { error_code, ...extra } = this.extraSignals(Boolean(this.error));
    for (const [port, value] of Object.entries({
      busy: this.state === "running",
      error: !!this.error,
      ...extra,
    }))
      this.signals.push(this.write(port, value, writer));
    if (this.hasFaultCodePort) {
      this.signals.push(
        this.write("error_code", error_code ?? (this.error ? 1 : 0), writer),
      );
    }
    this.signals.push(...this.latch.publish());
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

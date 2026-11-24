/** 把工艺调度器、设备驱动和共享物理世界接入同一次场景运行，每步根据上一帧反馈下发动作并发布新的信号和观测。 */

import type {
  BoundProcess,
  ActionFeedback,
  SchedulerSnapshot,
} from "@/contracts/scheduler";
import type { SceneSignalFrame } from "@/contracts/scene-signals";
import { SignalRegistry } from "@/runtime/signals/SignalRegistry";
import {
  ObservationRegistry,
  type ObservationFrame,
} from "@/runtime/signals/ObservationRegistry";
import { ProcessScheduler } from "@/runtime/scheduler/ProcessScheduler";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import { SceneWorldStepper, type SceneWorld } from "./SceneWorldStepper";
import type { ConditionDiagnostics } from "@/contracts/condition-expression";

export interface SceneRuntimeSnapshot {
  sceneInstanceId: string;
  runId: string;
  tick: number;
  status: string;
  error?: string;
  signals: Readonly<SceneSignalFrame>;
  observations: Readonly<ObservationFrame>;
  process: Readonly<SchedulerSnapshot>;
  conditions?: ConditionDiagnostics;
}
export type SceneVisualSnapshot = Pick<
  SceneRuntimeSnapshot,
  "runId" | "tick" | "status" | "observations"
>;
/** Scene composition root. A step consumes the last complete feedback frame. */
export class SceneRuntimeProgram {
  readonly scheduler: ProcessScheduler;
  private stepper: SceneWorldStepper;
  private drivers: ReadonlyMap<string, DeviceActionPort>;
  private feedback: ActionFeedback[] = [];
  private error?: string;
  private disposed = false;
  constructor(
    readonly sceneInstanceId: string,
    readonly runId: string,
    private process: BoundProcess,
    readonly signals: SignalRegistry,
    world: SceneWorld,
    drivers: readonly DeviceActionPort[],
    private observations = new ObservationRegistry(runId, []),
  ) {
    if (signals.runId !== runId)
      throw new Error("Registry run identity differs");
    if (
      !sceneInstanceId ||
      signals.layout().some((s) => !s.key.startsWith(sceneInstanceId + "/"))
    )
      throw new Error("Signal namespace differs from scene instance");
    this.drivers = new Map(drivers.map((d) => [d.id, d]));
    if (this.drivers.size !== drivers.length)
      throw new Error("Duplicate device driver");
    for (const b of process.actions.values())
      if (!this.drivers.get(b.device)?.supports(b.behavior))
        throw new Error(
          "Missing registered executor: " + b.device + "." + b.behavior,
        );
    this.scheduler = new ProcessScheduler(runId, process);
    this.stepper = new SceneWorldStepper(
      world,
      [...drivers],
      process.deadlines.stop,
    );
  }
  start() {
    this.stepper.start();
  }
  needsStep() {
    return ["running", "stopping"].includes(this.stepper.snapshot().status);
  }
  pause() {
    this.stepper.pause();
  }
  resume() {
    this.stepper.resume();
  }
  stop() {
    this.scheduler.cancel();
    try {
      const frame = this.signals.snapshot(this.stepper.snapshot().tick);
      this.signals.commitInputs(
        [...this.drivers.values()].flatMap((d) => [...d.prepareStop(frame)]),
        frame.tick,
      );
    } catch (e) {
      this.error ??= e instanceof Error ? e.message : String(e);
    }
    this.stepper.stop();
  }
  step(dt: number): SceneRuntimeSnapshot {
    this.advance(dt);
    return this.snapshot();
  }
  /** The viewport needs poses on every tick; PLC diagnostics are sampled separately. */
  advance(dt: number): void {
    if (this.disposed) throw new Error("Scene session disposed");
    if (!Number.isFinite(dt) || Math.abs(dt - 1 / 60) > 1e-8)
      throw new Error("Invalid scene timestep");
    const current = this.stepper.snapshot();
    if (!["running", "stopping"].includes(current.status)) return;
    try {
      const frame = this.signals.snapshot(current.tick);
      const proposed = this.scheduler.advance({
        frame,
        feedback: this.feedback,
        observations: this.observations.snapshot(current.tick),
      });
      this.feedback = [];
      const cancelled = new Set(
        proposed
          .filter((e) => e.kind === "cancel")
          .map((e) => e.request.requestId),
      );
      const withdrawn = new Set(
        proposed
          .filter(
            (e) => e.kind === "submit" && cancelled.has(e.request.requestId),
          )
          .map((e) => e.request.requestId),
      );
      const receipts = proposed
        .filter(
          (e) => e.kind === "submit" && withdrawn.has(e.request.requestId),
        )
        .map((e) => ({
          ...e.request,
          status: "stopped" as const,
          reason: "cancelled_before_dispatch",
        }));
      const effects = proposed.filter(
        (e) => !withdrawn.has(e.request.requestId),
      );
      const writes = effects.flatMap((e) => {
        const d = this.drivers.get(e.request.device)!;
        return [
          ...(e.kind === "submit"
            ? d.prepare(e.request, frame)
            : d.prepareCancel(e.request, frame)),
        ];
      });
      this.signals.commitInputs(writes, current.tick);
      for (const e of effects) {
        const driver = this.drivers.get(e.request.device)!;
        if (e.kind === "submit") driver.submit(e.request);
        else driver.cancel(e.request);
      }
      if (
        ["succeeded", "failed", "cancelled", "attention_required"].includes(
          this.scheduler.currentStatus,
        )
      ) {
        this.signals.commitInputs(
          [...this.drivers.values()].flatMap((d) => [...d.prepareStop(frame)]),
          current.tick,
        );
        this.stepper.stop();
      }
      const next = this.stepper.step(dt);
      if (next.status === "attention_required")
        throw new Error(next.error ?? "Physical world fault");
      const outputs = [...this.drivers.values()].flatMap((d) => [
        ...d.drainSignals(),
      ]);
      this.signals.publishFeedback(outputs, next.tick);
      this.observations.publish(
        [...this.drivers.values()].flatMap((d) => [
          ...(d.drainObservations?.() ?? []),
        ]),
        next.tick,
      );
      this.feedback = [
        ...receipts,
        ...[...this.drivers.values()].flatMap((d) => [...d.drainFeedback()]),
      ];
      const accepted = new Map(
        this.feedback
          .filter((f) => f.status === "accepted")
          .map((f) => [f.requestId, f]),
      );
      if (accepted.size) {
        const feedbackFrame = this.signals.snapshot(next.tick);
        this.signals.commitInputs(
          [...accepted.values()].flatMap(
            (f) =>
              this.drivers.get(f.device)?.acknowledge?.(f, feedbackFrame) ?? [],
          ),
          next.tick,
        );
      }
      if (
        next.status === "stopped" &&
        this.scheduler.currentStatus === "stopping"
      ) {
        const cleanup = this.scheduler.advance({
          frame: this.signals.snapshot(next.tick),
          observations: this.observations.snapshot(next.tick),
          feedback: this.feedback,
        });
        this.feedback = [];
        for (const e of cleanup) {
          if (e.kind !== "cancel")
            throw new Error("Cannot submit after world stop");
          this.drivers.get(e.request.device)!.cancel(e.request);
        }
        if (this.scheduler.currentStatus === "stopping")
          throw new Error(
            "World stopped without correlated request stop confirmation",
          );
      }
    } catch (e) {
      this.error ??= e instanceof Error ? e.message : String(e);
      this.stop();
    }
  }
  visualSnapshot(): SceneVisualSnapshot {
    const world = this.stepper.snapshot();
    return Object.freeze({
      runId: this.runId,
      tick: world.tick,
      status: this.disposed
        ? "disposed"
        : this.error
          ? "attention_required"
          : world.status === "stopped"
            ? this.scheduler.currentStatus
            : world.status,
      observations: this.observations.snapshot(world.tick),
    });
  }
  snapshot(): SceneRuntimeSnapshot {
    const visual = this.visualSnapshot(),
      process = this.scheduler.snapshot();
    return Object.freeze({
      ...visual,
      sceneInstanceId: this.sceneInstanceId,
      error: this.error ?? this.stepper.snapshot().error ?? process.error,
      signals: this.signals.snapshot(visual.tick),
      process,
      conditions: this.process.providers.diagnostics?.(),
    });
  }
  dispose() {
    this.stepper.dispose();
    this.disposed = true;
  }
  discard() {
    this.stepper.discard(Boolean(this.error));
    this.disposed = true;
  }
}

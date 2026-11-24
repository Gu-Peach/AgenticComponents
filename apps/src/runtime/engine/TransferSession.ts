/** 将共享场景调度的组合工艺映射到工作台已有的单设备视口；停止时继续推进到受控制停。 */
import type { RuntimeSnapshot } from "@/contracts/runtime";
import type { TransferWorkcell } from "@/domain/runtime/compileTransferWorkcell";
import type { SceneRuntimeProgram } from "./SceneRuntimeProgram";
import type { ArmReading, CellReading } from "../assembly/TransferWorkcell";

export class TransferSession {
  constructor(
    readonly compiled: TransferWorkcell,
    readonly program: SceneRuntimeProgram,
  ) {}
  snapshot(): RuntimeSnapshot {
    const s = this.program.snapshot(),
      c = this.compiled,
      w = s.observations.samples["cell/state"].value as CellReading;
    const r = s.observations.samples[c.selection.robot + "/robot_state"]
      ?.value as ArmReading | undefined;
    const request = s.process.activations.filter((a) => a.requestId).at(-1);
    const terminal = [
      "succeeded",
      "failed",
      "cancelled",
      "attention_required",
    ].includes(s.status);
    const status =
      s.status === "ready" || s.status === "paused"
        ? s.status
        : terminal
          ? s.status === "failed" || s.status === "attention_required"
            ? "failed"
            : "stopped"
          : "running";
    return {
      kind: "assembled_transfer",
      status,
      tick: s.tick,
      time: s.tick / 60,
      subjectId: c.selection.material,
      materialInstanceId: c.selection.material,
      instanceId: c.selection.robot,
      bodyLocalMatrix: c.belt.bodyLocalMatrix,
      pose: w.pose,
      size: c.belt.physics.materialSize,
      supported: w.supported || w.targetSupported,
      atExit: w.atExit,
      error: s.error,
      workcell: {
        status: s.status,
        connections: c.connections,
        step: request?.node,
        q: r?.q ?? [0, 0, 0, 0, 0, 0],
      },
      request: request
        ? {
            requestId: request.requestId!,
            subjectId: c.selection.material,
            status:
              s.status === "succeeded"
                ? "succeeded"
                : s.status === "cancelled"
                  ? "cancelled"
                  : status === "failed"
                    ? "failed"
                    : "busy",
          }
        : null,
      signals: Object.fromEntries(
        Object.entries(s.signals.samples)
          .filter(([, v]) => v.value !== null)
          .map(([k, v]) => [
            k.slice(s.sceneInstanceId.length + 1),
            {
              value: v.value!,
              valid: v.quality === "good",
              tick: v.sampledTick,
              writer: v.writer,
            },
          ]),
      ),
    };
  }
  reset() {
    const p = this.program;
    if (p.needsStep() || p.visualSnapshot().status === "paused") p.stop();
    for (let i = 0; i <= 1801 && p.needsStep(); i++) p.advance(1 / 60);
    if (p.visualSnapshot().status === "attention_required") p.discard();
    else p.dispose();
  }
}

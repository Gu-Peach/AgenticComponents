/** 执行指定工件的定时加工，每个仿真步检查工件和机械臂是否满足加工条件，周期结束后提交该工件的加工结果。 */

import type { ActionRequest } from "@/contracts/scheduler";
import type { SceneSignalFrame } from "@/contracts/scene-signals";
import { WarehouseActionAdapter } from "@/runtime/adapters/scene/WarehouseActionAdapter";

/** 工位提供按物料身份核实的支承、安全与加工提交能力。 */
export interface MachiningWorkpoint {
  ready(material: string): boolean;
  finish(material: string, requestId: string, tick: number): void;
}

/** The machine owns the timed operation. Losing custody or stopping leaves the workpiece raw. */
export class MachineToolAdapter extends WarehouseActionAdapter {
  constructor(
    id: string,
    sceneId: string,
    runId: string,
    cycleTicks: number,
    subject: (r: ActionRequest) => string,
    environment: MachiningWorkpoint,
  ) {
    super(
      id,
      sceneId,
      runId,
      ["machine_material"],
      (r) => {
        const material = subject(r);
        if (!environment.ready(material))
          throw new Error("Workpiece is not ready for machining: " + material);
        let ticks = 0,
          completed = false,
          cancelled = false;
        return {
          begin() {},
          before() {},
          after(tick) {
            if (cancelled) return;
            if (!environment.ready(material))
              throw new Error("Machining interlock lost: " + material);
            if (++ticks === cycleTicks) {
              environment.finish(material, r.requestId, tick);
              completed = true;
            }
          },
          cancel() {
            cancelled = true;
          },
          complete: () => completed,
          stopped: () => cancelled || completed,
          canResetFault: () => environment.ready(material),
        };
      },
      () => true,
    );
  }
  override prepare(r: ActionRequest, frame: Readonly<SceneSignalFrame>) {
    return [
      ...super.prepare(r, frame),
      {
        key: this.sceneId + "/" + this.id + "/subject_id",
        writer: "process",
        runId: this.runId,
        requestId: r.requestId,
        activationId: r.activationId,
        subjectId: r.subjectId,
        value: Number(r.arguments.subject_id),
      },
    ];
  }
}

/** 由实例绑定提供工位和区域观测，按本次请求确认毛坯加工与状态提交。 */
export const machiningConditions = [
  "machine_material.ready",
  "machine_material.authorized",
  "machine_material.sustaining",
  "machine_material.completion",
] as const;

export interface WorkpointEvidence {
  occupiedBy: string | null;
  supported: boolean;
  interlocksClear: boolean;
  materialState?: "raw" | "finished";
  operations: ReadonlyArray<{ material: string; request: string }>;
}
export function evaluateMachiningCondition(
  key: string,
  evidence: WorkpointEvidence,
  material: string,
  request: string,
  succeeded: boolean,
  authorized: () => boolean,
) {
  if (
    !evidence.supported ||
    !evidence.interlocksClear ||
    evidence.occupiedBy !== material
  )
    return false;
  const ready = evidence.materialState === "raw";
  const completed =
    evidence.materialState === "finished" &&
    evidence.operations.some(
      (op) => op.material === material && op.request === request,
    );
  switch (key) {
    case "machine_material.ready":
      return ready;
    case "machine_material.authorized":
      return ready && authorized();
    case "machine_material.sustaining":
      return ready || completed;
    case "machine_material.completion":
      return completed && succeeded;
    default:
      throw new Error("Unknown machine condition: " + key);
  }
}

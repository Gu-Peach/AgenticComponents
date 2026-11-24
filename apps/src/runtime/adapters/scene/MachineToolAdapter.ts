/** 执行指定工件的定时加工，每个仿真步检查工件和机械臂是否满足加工条件，周期结束后提交该工件的加工结果。 */

import type { ActionRequest } from "@/contracts/scheduler";
import type { SceneSignalFrame } from "@/contracts/scene-signals";
import type { MachiningLineEnvironment } from "@/runtime/services/MachiningLineEnvironment";
import { WarehouseActionAdapter } from "./WarehouseActionAdapter";

/** The machine owns the timed operation. Losing custody or stopping leaves the workpiece raw. */
export class MachineToolAdapter extends WarehouseActionAdapter {
  constructor(
    id: string,
    sceneId: string,
    runId: string,
    cycleTicks: number,
    subject: (r: ActionRequest) => string,
    environment: MachiningLineEnvironment,
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

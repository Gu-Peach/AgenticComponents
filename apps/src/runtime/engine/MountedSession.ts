/** 将挂载物理世界的实测位移映射到单设备视口。 */
import { emptySnapshot } from "./RuntimeSnapshot";
import type { RuntimeSnapshot } from "@/contracts/runtime";
import type { MountedReading } from "../assembly/MountedWorkcell";
import type { SceneRuntimeProgram } from "./SceneRuntimeProgram";
import { disposeWorkcellProgram, workcellStatus } from "./TransferSession";
export class MountedSession {
  constructor(
    readonly rail: string,
    readonly program: SceneRuntimeProgram,
  ) {}
  snapshot(): RuntimeSnapshot {
    const s = this.program.snapshot(),
      value = s.observations.samples["mount/state"].value as MountedReading;
    return {
      ...emptySnapshot(),
      kind: "mounted_axes",
      instanceId: this.rail,
      tick: s.tick,
      time: s.tick / 60,
      status: workcellStatus(s.status),
      error: s.error,
      mounted: {
        ...value,
        status: s.status,
        step: s.process.activations.filter((a) => a.requestId).at(-1)?.node,
      },
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
    disposeWorkcellProgram(this.program);
  }
}

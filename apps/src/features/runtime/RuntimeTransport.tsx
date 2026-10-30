import { useSyncExternalStore } from "react";
import { runtimeController } from "@/services/RuntimeController";
export function RuntimeTransport() {
  const s = useSyncExternalStore(
    runtimeController.subscribe,
    runtimeController.snapshot,
    runtimeController.snapshot,
  );
  return (
    <div className="transport-controls">
      <span>仿真 · {s.time.toFixed(2)} s</span>
      <button
        aria-label="暂停场景"
        disabled={s.status !== "running"}
        onClick={() => runtimeController.pause()}
      >
        暂停
      </button>
      <button
        aria-label="继续场景"
        disabled={s.status !== "paused"}
        onClick={() => runtimeController.resume()}
      >
        继续
      </button>
      <button aria-label="停止场景" onClick={() => runtimeController.stop()}>
        停止
      </button>
      <button aria-label="重置场景" onClick={() => runtimeController.reset()}>
        重置
      </button>
    </div>
  );
}

import { useSyncExternalStore } from "react";
import { runtimeController } from "@/services/RuntimeController";
export function RuntimeSignalsPanel() {
  const s = useSyncExternalStore(
    runtimeController.subscribe,
    runtimeController.snapshot,
    runtimeController.snapshot,
  );
  return (
    <details>
      <summary>引擎信号 · {s.instanceId ?? "尚未准备"}</summary>
      {Object.entries(s.signals).map(([key, v]) => (
        <p key={key}>
          {key}: {String(v.value)} · tick {v.tick} · {v.valid ? "有效" : "未知"}
        </p>
      ))}
    </details>
  );
}

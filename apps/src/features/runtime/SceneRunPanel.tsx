import { useState, useSyncExternalStore } from "react";
import type { ScenePackageInstance } from "@/contracts/scene-package";
import { sceneRuntimeController as controller } from "@/services/SceneRuntimeController";

export function SceneRunPanel({ scene }: { scene: ScenePackageInstance }) {
  const runtime = useSyncExternalStore(
    controller.subscribe,
    () => controller.snapshot(scene.id),
    () => undefined,
  );
  const preparation = useSyncExternalStore(
    controller.subscribe,
    () => controller.readiness(scene.id),
    () => undefined,
  );
  const [error, setError] = useState("");
  const act = (fn: () => unknown) => {
    setError("");
    Promise.resolve()
      .then(fn)
      .catch((e) => setError(String(e.message ?? e)));
  };
  const status = runtime?.status;
  return (
    <section
      aria-label="场景运行"
      style={{ padding: 12, border: "1px solid #345", marginBottom: 16 }}
    >
      <strong>场景运行 · {status ?? preparation?.status ?? "未准备"}</strong>
      <p>候选仿真使用真实物理与契约反馈；通过准入不代表整场工艺已验收。</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!runtime && preparation?.status !== "preparing" && (
          <button
            onClick={() => act(() => controller.prepare(scene, "validation"))}
          >
            准备候选仿真
          </button>
        )}
        {preparation?.status === "preparing" && (
          <button onClick={() => controller.cancelPrepare(scene.id)}>
            取消准备
          </button>
        )}
        {status === "ready" && (
          <button onClick={() => act(() => controller.start(scene.id))}>
            运行
          </button>
        )}
        {status === "running" && (
          <button onClick={() => act(() => controller.pause(scene.id))}>
            暂停
          </button>
        )}
        {status === "paused" && (
          <button onClick={() => act(() => controller.resume(scene.id))}>
            继续
          </button>
        )}
        {["ready", "running", "paused"].includes(status ?? "") && (
          <button onClick={() => act(() => controller.stop(scene.id))}>
            停止
          </button>
        )}
        {runtime &&
          !["running", "paused", "stopping", "attention_required"].includes(
            status ?? "",
          ) && (
            <button onClick={() => act(() => controller.detach(scene.id))}>
              重置
            </button>
          )}
        {status === "attention_required" &&
          (controller.configuration(scene.id)?.warehouse ||
            controller.configuration(scene.id)?.loading) && (
            <button onClick={() => act(() => controller.discard(scene.id))}>
              放弃本次仿真并恢复初态
            </button>
          )}
      </div>
      {(error || preparation?.error || runtime?.error) && (
        <p role="alert">{error || preparation?.error || runtime?.error}</p>
      )}
      {preparation?.warnings.length ? (
        <details>
          <summary>仿真范围与标定说明</summary>
          <ul>
            {preparation.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {runtime && (
        <p>
          run {runtime.runId} · tick {runtime.tick} ·{" "}
          {runtime.process.activations
            .filter((a) => a.blockedBy.length)
            .at(-1)
            ?.blockedBy.join("；")}
        </p>
      )}
    </section>
  );
}

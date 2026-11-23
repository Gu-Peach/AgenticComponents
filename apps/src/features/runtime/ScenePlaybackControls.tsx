import { useState, useSyncExternalStore } from "react";
import { Pause, Play, Square } from "lucide-react";
import type { ScenePackageInstance } from "@/contracts/scene-package";
import { sceneRuntimeController as controller } from "@/services/SceneRuntimeController";
import { reportError } from "@/commands/workspaceCommands";

const labels: Record<string, string> = {
  idle: "待播放",
  preparing: "准备中",
  ready: "就绪",
  running: "播放中",
  paused: "已暂停",
  stopping: "正在停止",
  cancelled: "已停止",
  succeeded: "已完成",
  failed: "失败",
  blocked: "准备中断",
  attention_required: "待处理",
};
const replayable = new Set(["succeeded", "failed", "cancelled"]);

function PlaybackRate({ id }: { id: string }) {
  const rate = useSyncExternalStore(
    controller.subscribe,
    () => controller.getPlaybackRate(id),
    () => 1,
  );
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (value: string) => {
    setDraft(null);
    if (value === String(rate)) return;
    try {
      controller.setPlaybackRate(id, Number(value));
    } catch (error) {
      reportError(error);
    }
  };
  return (
    <label
      className="scene-playback-rate"
      title="播放速度（0.1 至 4 倍），按 Enter 或移开焦点应用"
    >
      <input
        aria-label="场景播放速度"
        type="number"
        inputMode="decimal"
        min={0.1}
        max={4}
        step="any"
        value={draft ?? rate}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.stopPropagation();
            setDraft(null);
          }
        }}
      />
      <span aria-hidden="true">×</span>
    </label>
  );
}

export function ScenePlaybackControls({
  scene,
}: {
  scene: ScenePackageInstance;
}) {
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
  const status = runtime?.status ?? preparation?.status ?? "idle";
  const playLabel =
    status === "paused"
      ? "继续场景"
      : replayable.has(status)
        ? "重新播放场景"
        : "播放场景";
  const play = async () => {
    const id = scene.id;
    const current = controller.snapshot(id)?.status;
    if (current === "paused") return controller.resume(id);
    if (current === "ready") return controller.start(id);
    if (controller.readiness(id)?.status === "preparing") return;
    if (current && !replayable.has(current)) return;
    if (current) controller.detach(id);
    const runId = await controller.prepare(scene, "validation");
    const prepared = controller.snapshot(id);
    if (runId && prepared?.runId === runId && prepared.status === "ready")
      controller.start(id);
  };
  const stop = () => {
    if (controller.readiness(scene.id)?.status === "preparing")
      controller.cancelPrepare(scene.id);
    else controller.stop(scene.id);
  };
  const invoke = async (action: () => unknown) => {
    try {
      await action();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      reportError(error);
    }
  };
  const detail = runtime?.error ?? preparation?.error;
  return (
    <div className="transport-controls" role="group" aria-label="场景播放控制">
      <span className="preview-indicator" title={detail ?? scene.bundle.name}>
        {scene.bundle.id} · {labels[status] ?? status}
        <span className={status === "running" ? "led green" : "led"} />
      </span>
      <button
        type="button"
        className="icon-button play"
        aria-label={playLabel}
        title={playLabel}
        disabled={
          !["idle", "blocked", "ready", "paused"].includes(status) &&
          !replayable.has(status)
        }
        onClick={() => void invoke(play)}
      >
        <Play size={15} fill="currentColor" />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="暂停场景"
        title="暂停场景"
        disabled={status !== "running"}
        onClick={() => void invoke(() => controller.pause(scene.id))}
      >
        <Pause size={15} />
      </button>
      <button
        type="button"
        className="icon-button stop"
        aria-label={status === "preparing" ? "取消场景准备" : "停止场景"}
        title={status === "preparing" ? "取消场景准备" : "停止场景"}
        disabled={!["preparing", "ready", "running", "paused"].includes(status)}
        onClick={() => void invoke(stop)}
      >
        <Square size={13} fill="currentColor" />
      </button>
      <span className="clock-display" aria-label="场景仿真时间">
        {((runtime?.tick ?? 0) / 60).toFixed(2)} s
      </span>
      <PlaybackRate id={scene.id} />
    </div>
  );
}

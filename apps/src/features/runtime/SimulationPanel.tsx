import { useState, useSyncExternalStore } from "react";
import { runtimeController } from "@/services/RuntimeController";
import { useWorkspace } from "@/stores/workspace";
import { reportError } from "@/commands/workspaceCommands";
export function SimulationPanel() {
  const state = useSyncExternalStore(
    runtimeController.subscribe,
    runtimeController.snapshot,
    runtimeController.snapshot,
  );
  const { project, selectedId, documentLocked } = useWorkspace();
  const [speed, setSpeed] = useState("0.4");
  const selected = project?.instances.find((i) => i.instanceId === selectedId);
  const definition = project?.definitions.find(
    (d) => d.specId === selected?.specId,
  );
  const executable = definition?.source?.contract_version === "1.2";
  const run = () => {
    if (project && selected)
      void runtimeController.prepare(project, selected).catch(reportError);
  };
  return (
    <div className="simulation-panel">
      <strong>接触式输送实验</strong>
      <small>
        仅选中输送面与 0.2 kg 实验箱体参与物理；其余场景设备不参与本实验。
      </small>
      <div className="row">
        <button
          disabled={!selected || documentLocked || !executable}
          onClick={run}
        >
          启动输送实验
        </button>
        <button
          disabled={state.status !== "running"}
          onClick={() => runtimeController.pause()}
        >
          暂停仿真
        </button>
        <button
          disabled={state.status !== "paused"}
          onClick={() => runtimeController.resume()}
        >
          继续仿真
        </button>
        <button
          disabled={!runtimeController.isBusy()}
          onClick={() => runtimeController.stop()}
        >
          停止仿真
        </button>
        <button
          disabled={state.status === "idle"}
          onClick={() => runtimeController.reset()}
        >
          重置仿真
        </button>
      </div>
      <label>
        表面速度 m/s{" "}
        <input
          aria-label="仿真速度"
          type="number"
          min="0"
          max="2"
          step="0.1"
          value={speed}
          onChange={(e) => setSpeed(e.target.value)}
        />
      </label>
      <div className="row">
        <button
          disabled={!runtimeController.isBusy() || state.status === "preparing"}
          onClick={() => {
            try {
              runtimeController.command("speedTag", Number(speed));
              runtimeController.command("runTag", true);
            } catch (e) {
              reportError(e);
            }
          }}
        >
          应用运行速度
        </button>
        <button
          disabled={!runtimeController.isBusy() || state.status === "preparing"}
          onClick={() => runtimeController.command("runTag", false)}
        >
          受控停带
        </button>
      </div>
      <p data-testid="simulation-status">
        {state.status} · {state.time.toFixed(2)} s ·{" "}
        {state.supported ? "有支承接触" : "无支承接触"}
      </p>
      <p data-testid="arrival-status">
        出口任务：{state.request?.status ?? "无"} {state.request?.reason}
      </p>
      {state.pose && (
        <p data-testid="material-position">
          物料位置：{state.pose.position.map((n) => n.toFixed(3)).join(", ")}
        </p>
      )}
      <p>
        表面实际速度：
        {Number(state.signals.actual_speed?.value ?? 0).toFixed(3)}{" "}
        m/s；物料速度：
        {state.pose ? Math.hypot(...state.pose.velocity).toFixed(3) : "—"}
      </p>
      {state.error && <p role="alert">{state.error}</p>}
    </div>
  );
}

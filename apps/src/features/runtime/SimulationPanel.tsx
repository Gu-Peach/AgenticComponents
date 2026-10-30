import { placeMaterial } from "@/domain/runtime/placeMaterial";
import { ParameterField } from "@/components/ui/ParameterField";
import { resolveParameters } from "@/validation/contracts";
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
  const [materialId, setMaterialId] = useState("");
  const selected = project?.instances.find((i) => i.instanceId === selectedId);
  const definition = project?.definitions.find(
    (d) => d.specId === selected?.specId,
  );
  const version = definition?.source?.contract_version;
  const executable = ["1.2", "1.3"].includes(String(version));
  const materials =
    project?.instances.filter(
      (i) =>
        i.visible &&
        project.definitions.some(
          (d) =>
            d.specId === i.specId &&
            d.deviceType === "workpiece" &&
            d.source?.contract_version === "1.3",
        ),
    ) ?? [];
  const material =
    materials.find((i) => i.instanceId === materialId) ?? materials[0];
  const md = project?.definitions.find((d) => d.specId === material?.specId);
  const mass =
    md && material
      ? resolveParameters(md, material.paramOverrides).mass_kg
      : undefined;

  const run = () => {
    if (project && selected)
      void runtimeController
        .prepare(project, selected, material?.instanceId)
        .catch(reportError);
  };
  return (
    <div className="simulation-panel">
      <strong>接触式输送实验</strong>
      <small>
        仅选中输送面与所选物料参与物理；质量需明确填写，其他场景设备不参与本次运行。
      </small>
      {version === "1.3" && (
        <>
          <label>
            运行物料
            <select
              aria-label="运行物料"
              disabled={documentLocked}
              value={material?.instanceId ?? ""}
              onChange={(e) => setMaterialId(e.target.value)}
            >
              <option value="" disabled>
                请先添加物料资产
              </option>
              {materials.map((i) => (
                <option key={i.instanceId} value={i.instanceId}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          {material && md && (
            <>
              <label>
                物料质量（kg，实验设定）
                <ParameterField
                  name="物料质量"
                  spec={md.paramsSchema.mass_kg}
                  value={mass}
                  disabled={documentLocked}
                  onCommit={(value) => {
                    const n = Number(value);
                    if (!Number.isFinite(n) || n <= 0 || n > 500) {
                      reportError(new Error("请输入有效的正质量，最多500 kg"));
                      return;
                    }
                    useWorkspace
                      .getState()
                      .updateInstance(material.instanceId, {
                        paramOverrides: {
                          ...material.paramOverrides,
                          mass_kg: n,
                        },
                      });
                  }}
                />
              </label>
              <button
                disabled={documentLocked}
                onClick={() => {
                  try {
                    if (project && selected)
                      useWorkspace
                        .getState()
                        .updateInstance(material.instanceId, {
                          transform: placeMaterial(
                            project,
                            selected.instanceId,
                            material.instanceId,
                          ),
                        });
                  } catch (e) {
                    reportError(e);
                  }
                }}
              >
                物料放到入口并对齐
              </button>
            </>
          )}
        </>
      )}
      <div className="row">
        <button
          disabled={
            !selected ||
            documentLocked ||
            !executable ||
            (version === "1.3" && !material)
          }
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

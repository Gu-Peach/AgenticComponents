import { useState, useSyncExternalStore } from "react";
import { useWorkspace } from "@/stores/workspace";
import { runtimeController } from "@/services/RuntimeController";
import { reportError } from "@/commands/workspaceCommands";
import { decodeProcessNode, type ProcessNode } from "@/contracts/process-ir";
import { mountedProcess } from "@/domain/runtime/compileMountedWorkcell";

export function MountedAxisPanel({ rail }: { rail: string }) {
  const { project, documentLocked } = useWorkspace();
  const state = useSyncExternalStore(
    runtimeController.subscribe,
    runtimeController.snapshot,
    runtimeController.snapshot,
  );
  const [position, setPosition] = useState("0"),
    [height, setHeight] = useState("1");
  const [custom, setCustom] = useState<{ name: string; root: ProcessNode }>();
  if (!project) return null;
  const railInstance = project.instances.find((i) => i.instanceId === rail);
  const railDef = project.definitions.find(
    (d) => d.specId === railInstance?.specId,
  );
  const carriage = railDef?.spatialInterfaces?.find(
    (p) => p.capabilities.snap.role === "carriage_mount",
  );
  const link = project.connections?.find((c) =>
    [c.a, c.b].some(
      (e) => e.instanceId === rail && e.interfaceId === carriage?.interface_id,
    ),
  );
  const child = project.instances.find(
    (i) =>
      i.instanceId ===
      (link?.a.instanceId === rail ? link.b.instanceId : link?.a.instanceId),
  );
  const lift =
    project.definitions.find((d) => d.specId === child?.specId)?.deviceType ===
    "lift_table";
  const active = state.instanceId === rail && state.mounted;
  return (
    <div className="simulation-panel">
      <p>
        {child
          ? "挂载设备 · " + child.name
          : "将设备底部接口吸附到滑座后可运行。"}
      </p>
      <small>
        滑轨带动一个直接挂载件，并对其他可见独立设备的静止几何校验净空。示意资产和整场景背景不参与本次物理计算；平台自由载物请用整场景验证。
      </small>
      <label>
        滑轨目标位置（m）
        <input
          type="number"
          step="any"
          value={position}
          disabled={documentLocked || !!custom}
          onChange={(e) => setPosition(e.target.value)}
        />
      </label>
      {lift && (
        <label>
          平台目标高度（m）
          <input
            type="number"
            step="any"
            value={height}
            disabled={documentLocked || !!custom}
            onChange={(e) => setHeight(e.target.value)}
          />
        </label>
      )}
      <label>
        定位工艺 IR（可选）
        <input
          type="file"
          accept=".json"
          disabled={documentLocked}
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (!file) return;
            try {
              const v = JSON.parse(await file.text());
              setCustom({
                name: file.name,
                root: decodeProcessNode(v.body ?? v),
              });
            } catch (error) {
              setCustom(undefined);
              reportError(error);
            }
          }}
        />
      </label>
      {custom && (
        <button disabled={documentLocked} onClick={() => setCustom(undefined)}>
          恢复数值工步 · {custom.name}
        </button>
      )}
      <button
        disabled={
          documentLocked ||
          !child ||
          (!custom && (!position.trim() || (lift && !height.trim())))
        }
        onClick={() =>
          void runtimeController
            .prepareMounted(
              project,
              rail,
              custom?.root ??
                mountedProcess(
                  Number(position),
                  lift ? Number(height) : undefined,
                ),
            )
            .catch(reportError)
        }
      >
        运行挂载定位
      </button>
      {active && (
        <>
          <p role="status">
            {active.status} · {active.step ?? "准备"}
          </p>
          {Object.entries(active.positions).map(([id, v]) => (
            <p key={id}>
              {project.instances.find((i) => i.instanceId === id)?.name ?? id} ·{" "}
              {v.toFixed(3)} m
            </p>
          ))}
          <button
            disabled={state.status !== "running"}
            onClick={() => runtimeController.pause()}
          >
            暂停
          </button>
          <button
            disabled={state.status !== "paused"}
            onClick={() => runtimeController.resume()}
          >
            恢复
          </button>
          <button
            disabled={!["running", "paused"].includes(state.status)}
            onClick={() => runtimeController.stop()}
          >
            停止
          </button>
          <button onClick={() => runtimeController.reset()}>退出仿真</button>
        </>
      )}
      {state.status === "failed" && state.error && (
        <p role="alert">{state.error}</p>
      )}
    </div>
  );
}

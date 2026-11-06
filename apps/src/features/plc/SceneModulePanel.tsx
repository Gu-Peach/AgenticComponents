import type { ScenePackageInstance } from "@/contracts/scene-package";
import { sceneModules } from "@/domain/runtime/sceneModules";
import { useSyncExternalStore } from "react";
import { sceneRuntimeController } from "@/services/SceneRuntimeController";
import { sceneSignalDisplay } from "@/domain/runtime/sceneSignalDisplay";
import { SceneRunPanel } from "@/features/runtime/SceneRunPanel";
import { SceneProcessOutline } from "@/features/runtime/SceneProcessOutline";

export function SceneModulePanel({ scene }: { scene: ScenePackageInstance }) {
  const runtime = useSyncExternalStore(
    sceneRuntimeController.subscribe,
    () => sceneRuntimeController.snapshot(scene.id),
    () => undefined,
  );
  const modules = sceneModules(scene.bundle);
  return (
    <div
      style={{
        overflow: "auto",
        padding: 16,
        height: "100%",
        minHeight: 0,
        boxSizing: "border-box",
      }}
    >
      <h3>{scene.bundle.name} · 契约模块图</h3>
      <SceneRunPanel scene={scene} />
      <SceneProcessOutline scene={scene} runtime={runtime} />
      <p>
        {runtime
          ? `运行状态 ${runtime.status} · tick ${runtime.tick} · run ${runtime.runId}`
          : `未接入场景运行 · 信号值未知 · ${scene.bundle.blockers.length} 项运行依赖待完成`}
      </p>
      <p>
        左侧为设备输入，右侧为设备反馈。以下是设备接口投影，尚未生成可执行 PLC
        接线。
      </p>
      {modules.map((module) => (
        <section key={module.id} style={{ marginBlock: 20 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,1fr) 150px minmax(0,1fr)",
              gap: 12,
            }}
          >
            {(["input", "block", "output"] as const).map((side) =>
              side === "block" ? (
                <div
                  key={side}
                  style={{
                    border: "1px solid currentColor",
                    padding: 12,
                    textAlign: "center",
                  }}
                >
                  <strong>{module.id}</strong>
                  {module.groupedBy.length > 0 && (
                    <p>组驱动来源：{module.groupedBy.join(", ")}</p>
                  )}
                  <p>
                    {module.experimental ? "实验契约 · 未准入" : "设备接口"}
                  </p>
                  <small>
                    条件 / 请求 / 结果
                    <br />
                    {runtime ? "真实运行快照" : "执行器待接入"}
                  </small>
                </div>
              ) : (
                <table key={side}>
                  <thead>
                    <tr>
                      <th>{side === "input" ? "IN 命令" : "OUT 反馈"}</th>
                      <th>类型</th>
                      <th>值</th>
                    </tr>
                  </thead>
                  <tbody>
                    {module.ports
                      .filter((p) => p.direction === side)
                      .map((p) => (
                        <tr key={p.id}>
                          <td>
                            <code title={`${scene.id}/${module.id}/${p.id}`}>
                              {p.id}
                            </code>
                          </td>
                          <td>
                            {p.type}
                            {p.unit ? ` · ${p.unit}` : ""}
                          </td>
                          <td
                            aria-label={`${module.id}/${p.id} ${sceneSignalDisplay(runtime, scene.id, module.id, p.id).quality}`}
                            title={`质量：${sceneSignalDisplay(runtime, scene.id, module.id, p.id).quality}；采样 tick：${sceneSignalDisplay(runtime, scene.id, module.id, p.id).tick ?? "未知"}`}
                          >
                            {
                              sceneSignalDisplay(
                                runtime,
                                scene.id,
                                module.id,
                                p.id,
                              ).text
                            }
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              ),
            )}
          </div>
          <details>
            <summary>{module.calls.length} 个工艺调用</summary>
            {module.calls.map((call) => (
              <p key={call.node}>
                <code>{call.node}</code> → {call.behavior}{" "}
                {runtime?.process.activations
                  .filter((a) => a.node === call.node)
                  .at(-1)?.state ?? "未激活"}
              </p>
            ))}
          </details>
        </section>
      ))}
      <details>
        <summary>场景包标定记录（静态）</summary>
        <ul>
          {scene.bundle.blockers.map((b, i) => (
            <li key={i}>
              {b.device}: {b.code}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

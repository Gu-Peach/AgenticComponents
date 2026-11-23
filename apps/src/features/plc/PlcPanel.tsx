import { useRef, useState } from "react";
import { SceneLadderPanel } from "./ladder/SceneLadderPanel";
import { SceneModulePanel } from "./SceneModulePanel";
import { FileCode2, Download, Upload, CircleOff } from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { useActiveScene } from "@/hooks/useActiveScene";
import type { ScenePackageInstance } from "@/contracts/scene-package";
import { download } from "@/services/BrowserProjectRepository";
export function PlcPanel() {
  const scene = useActiveScene();
  if (scene) return <ScenePlc key={scene.id} scene={scene} />;
  return <PlcEditor />;
}

function ScenePlc({ scene }: { scene: ScenePackageInstance }) {
  const scenes = useWorkspace((s) => s.project?.scenePackages);
  const locked = useWorkspace((s) => s.documentLocked);
  const setActiveScene = useWorkspace((s) => s.setActiveScene);
  const [sceneView, setSceneView] = useState<"ladder" | "devices">("ladder");
  return (
    <div className="plc-panel">
      {scenes && scenes.length > 1 && (
        <div className="panel-toolbar">
          <label>
            当前场景{" "}
            <select
              aria-label="当前 PLC 场景"
              value={scene.id}
              disabled={locked}
              onChange={(e) => setActiveScene(e.currentTarget.value)}
            >
              {scenes.map((s, i) => (
                <option key={s.id} value={s.id}>
                  {i + 1}. {s.bundle.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {sceneView === "ladder" ? (
          <SceneLadderPanel
            scene={scene}
            onDevices={() => setSceneView("devices")}
          />
        ) : (
          <div
            style={{
              height: "100%",
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <button
              onClick={() => setSceneView("ladder")}
              style={{ alignSelf: "flex-start", margin: 8 }}
            >
              返回场景梯形图
            </button>
            <div style={{ flex: 1, minHeight: 0 }}>
              <SceneModulePanel scene={scene} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PlcEditor() {
  const project = useWorkspace((s) => s.project);
  const selectedId = useWorkspace((s) => s.selectedId);
  const input = useRef<HTMLInputElement>(null);
  const lines = useRef<HTMLDivElement>(null);
  const instance = project?.instances.find((i) => i.instanceId === selectedId);
  const def = project?.definitions.find((d) => d.specId === instance?.specId);
  return (
    <div className="plc-panel">
      <div className="panel-toolbar">
        <span>
          <FileCode2 size={14} /> Main.st <small>Structured Text</small>
        </span>
        <div className="row">
          <button onClick={() => input.current?.click()}>
            <Upload size={13} />
            导入
          </button>
          <button
            onClick={() =>
              download("Main.st", project?.plc ?? "", "text/plain")
            }
          >
            <Download size={13} />
            导出
          </button>
          <button disabled title="PLC 执行引擎尚未接入">
            <CircleOff size={13} />
            编译 / 运行未接入
          </button>
        </div>
      </div>
      <input
        hidden
        ref={input}
        type="file"
        accept=".st,.txt"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) {
            const text = await f.text();
            useWorkspace.getState().updateProject((p) => ({ ...p, plc: text }));
          }
        }}
      />
      <div className="plc-body">
        <div className="code-editor">
          <div className="line-numbers" ref={lines}>
            {(project?.plc ?? "").split("\n").map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <textarea
            aria-label="PLC 程序"
            spellCheck={false}
            value={project?.plc ?? ""}
            onScroll={(e) => {
              if (lines.current)
                lines.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onChange={(e) =>
              useWorkspace
                .getState()
                .updateProject((p) => ({ ...p, plc: e.target.value }))
            }
          />
        </div>
        <div className="signal-table">
          <div className="subheading">
            {instance?.name ?? "选中设备"} · I/O 映射
          </div>
          <table>
            <thead>
              <tr>
                <th>信号</th>
                <th>类型</th>
                <th>绑定</th>
              </tr>
            </thead>
            <tbody>
              {def?.interfaces.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="direction">
                      {s.direction === "input" ? "IN" : "OUT"}
                    </span>{" "}
                    {s.id}
                  </td>
                  <td>{s.valueType}</td>
                  <td>
                    {instance?.bindings[s.id] || (
                      <span className="muted">未绑定</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

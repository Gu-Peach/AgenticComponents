"use client";
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Maximize,
  Minimize,
  Play,
  Pause,
  Square,
  Save,
  FolderOpen,
  FilePlus2,
  Upload,
  Download,
  Cuboid,
  CircleHelp,
} from "lucide-react";
import { ProjectMark } from "@/components/ui/ProjectMark";
import { useWorkspace } from "@/stores/workspace";
import { usePreview } from "@/hooks/usePreview";
import { preview } from "@/runtime/services";
import {
  commandRegistry,
  importProject,
  importDefinition,
  associateGlb,
  reportError,
} from "@/commands/workspaceCommands";
export function TopBar() {
  const p = useWorkspace((s) => s.project);
  const dirty = useWorkspace((s) => s.dirty);
  const saving = useWorkspace((s) => s.saving);
  const state = usePreview();
  const [full, setFull] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [importKind, setImportKind] = useState<
    "project" | "definition" | "glb"
  >("project");
  useEffect(() => {
    const sync = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node))
        menu.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const choose = (kind: typeof importKind) => {
    setImportKind(kind);
    if (picker.current) {
      picker.current.accept = kind === "glb" ? ".glb" : ".json";
      picker.current.click();
    }
    menu.current?.removeAttribute("open");
  };
  const action = (fn: () => unknown) => {
    menu.current?.removeAttribute("open");
    Promise.resolve().then(fn).catch(reportError);
  };
  const owner = p?.instances.find(
    (i) => i.instanceId === state.request?.instanceId,
  )?.name;
  return (
    <header className="topbar">
      <div className="brand-mark" title="Agentic Components">
        <ProjectMark />
      </div>
      <div className="brand-name">
        AGENTIC<span>COMPONENTS</span>
      </div>
      <span className="top-divider" />
      <div className="project-name">
        <input
          aria-label="项目名称"
          value={p?.name ?? ""}
          onChange={(e) =>
            useWorkspace.getState().updateProject((p) => ({
              ...p,
              name: e.target.value || "未命名项目",
            }))
          }
        />
        {dirty && <span className="dirty-dot" title="尚未保存" />}
      </div>
      <details
        className="file-menu"
        ref={menu}
        onKeyDown={(e) => {
          if (e.key === "Escape") menu.current?.removeAttribute("open");
        }}
      >
        <summary>
          文件 <ChevronDown size={12} />
        </summary>
        <div className="menu-popover">
          <button onClick={() => action(commandRegistry.new.run)}>
            <FilePlus2 size={15} />
            新建项目
          </button>
          <button onClick={() => action(commandRegistry.save.run)}>
            <Save size={15} />
            保存到浏览器 <kbd>Ctrl S</kbd>
          </button>
          <button onClick={() => choose("project")}>
            <FolderOpen size={15} />
            导入项目 JSON
          </button>
          <button onClick={() => action(commandRegistry.export.run)}>
            <Download size={15} />
            导出项目数据
          </button>
          <hr />
          <button onClick={() => choose("definition")}>
            <Upload size={15} />
            导入设备 DeviceSpec
          </button>
          <button onClick={() => choose("glb")}>
            <Cuboid size={15} />
            为选中设备关联 GLB
          </button>
          <p>JSON 导出不含模型；浏览器保存包含已导入模型。</p>
        </div>
      </details>
      <input
        type="file"
        hidden
        ref={picker}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            if (importKind === "project") await importProject(file);
            else if (importKind === "definition")
              await importDefinition(JSON.parse(await file.text()));
            else await associateGlb(file);
          } catch (e) {
            reportError(e);
          }
        }}
      />
      <div className="transport-controls">
        <span className="preview-indicator" title={owner ?? "在右侧选择行为"}>
          {state.request?.mode === "mock" ? "MOCK" : "预览"}
          <span className={state.status === "running" ? "led green" : "led"} />
        </span>
        <button
          className="icon-button play"
          aria-label="继续预览"
          title="继续已暂停的预览；新预览请从右侧启动"
          disabled={state.status !== "paused"}
          onClick={() => preview.resume()}
        >
          <Play size={15} fill="currentColor" />
        </button>
        <button
          className="icon-button"
          aria-label="暂停预览"
          title="暂停预览"
          disabled={state.status !== "running" || !state.supportsPause}
          onClick={() => preview.pause()}
        >
          <Pause size={15} />
        </button>
        <button
          className="icon-button stop"
          aria-label="停止预览"
          title="停止预览"
          disabled={!["running", "paused", "preparing"].includes(state.status)}
          onClick={() => preview.stop().catch(reportError)}
        >
          <Square size={13} fill="currentColor" />
        </button>
        <span className="clock-display">{state.time.toFixed(2)} s</span>
      </div>
      <div className="top-actions">
        <span className="save-hint">
          {saving ? "保存中…" : dirty ? "未保存" : "本地工作区"}
        </span>
        <button
          className="icon-button"
          title="使用帮助"
          aria-label="使用帮助"
          onClick={() => {
            useWorkspace.setState({ dock: "terminal", dockOpen: true });
            useWorkspace
              .getState()
              .log(
                "选择设备查看明细；资产面板可添加实例；文件菜单导入 DeviceSpec / GLB。右侧勾选演示模式验证预览通路；真实动作接口待接入。",
              );
          }}
        >
          <CircleHelp size={17} />
        </button>
        <button
          className="icon-button"
          aria-label={full ? "退出全屏" : "进入全屏"}
          title="全屏"
          onClick={async () => {
            try {
              if (document.fullscreenElement) await document.exitFullscreen();
              else await document.documentElement.requestFullscreen();
            } catch (e) {
              reportError(e);
            }
          }}
        >
          {full ? <Minimize size={17} /> : <Maximize size={17} />}
        </button>
      </div>
    </header>
  );
}

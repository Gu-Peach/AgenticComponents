"use client";
import { TransformToolbar } from "./TransformToolbar";
import dynamic from "next/dynamic";
import { useEffect, useState, type CSSProperties } from "react";
import {
  Boxes,
  FileCode2,
  Terminal,
  ChevronDown,
  ChevronUp,
  PanelBottom,
  PanelLeftClose,
  PanelRightClose,
  PanelLeftOpen,
  PanelRightOpen,
  MousePointer2,
  Crosshair,
  RotateCcw,
  Grid2X2,
  X,
  CircleAlert,
} from "lucide-react";
import { ProjectMark } from "@/components/ui/ProjectMark";
import { TopBar } from "./TopBar";
import { SceneTree } from "@/features/bom/SceneTree";
import { Inspector } from "@/features/inspector/Inspector";
import { AssetPanel } from "@/features/catalog/AssetPanel";
import { PlcPanel } from "@/features/plc/PlcPanel";
import { TerminalPanel } from "@/features/terminal/TerminalPanel";
import { useWorkspace } from "@/stores/workspace";
import { usePreview } from "@/hooks/usePreview";
import { preview } from "@/runtime/services";
import { startPreviewClock } from "@/runtime/PreviewClock";
import { projectRepository } from "@/services/BrowserProjectRepository";
import {
  saveProject,
  reportError,
  refreshPublicCatalog,
} from "@/commands/workspaceCommands";
import styles from "./Workspace.module.css";
const SceneCanvas = dynamic(() => import("@/renderer/SceneCanvas"), {
  ssr: false,
  loading: () => (
    <div className="viewport-loading">
      <ProjectMark size={36} />
      <span>正在初始化三维工作区…</span>
    </div>
  ),
});
function Splitter({
  label,
  axis,
  reverse,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  axis: "x" | "y";
  reverse?: boolean;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div
      className={`splitter ${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      onPointerDown={(e) => {
        e.preventDefault();
        const start = axis === "x" ? e.clientX : e.clientY;
        const element = e.currentTarget;
        element.setPointerCapture(e.pointerId);
        const move = (event: PointerEvent) =>
          onChange(
            Math.max(
              min,
              Math.min(
                max,
                value +
                  ((axis === "x" ? event.clientX : event.clientY) - start) *
                    (reverse ? -1 : 1),
              ),
            ),
          );
        const done = () => {
          element.removeEventListener("pointermove", move);
          element.removeEventListener("pointerup", done);
          element.removeEventListener("lostpointercapture", done);
        };
        element.addEventListener("pointermove", move);
        element.addEventListener("pointerup", done);
        element.addEventListener("lostpointercapture", done);
      }}
      onKeyDown={(e) => {
        if (
          ["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(e.key)
        ) {
          e.preventDefault();
          onChange(
            Math.max(
              min,
              Math.min(
                max,
                value + (["ArrowRight", "ArrowUp"].includes(e.key) ? 10 : -10),
              ),
            ),
          );
        }
      }}
    />
  );
}
export default function WorkspaceClient() {
  const { project, selectedId, dock, dockOpen, dirty, notice, logs } =
    useWorkspace();
  const state = usePreview();
  const [ready, setReady] = useState(false);
  const [left, setLeft] = useState(242);
  const [right, setRight] = useState(320);
  const [bottom, setBottom] = useState(232);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let alive = true;
    void refreshPublicCatalog();
    projectRepository
      .load()
      .then((p) => {
        if (alive) {
          useWorkspace.getState().initialize(p ?? undefined);
          useWorkspace
            .getState()
            .log(
              p
                ? "已恢复浏览器保存的项目"
                : "工作台就绪。示例设备使用占位模型；真实动画接口待接入。",
            );
          setReady(true);
        }
      })
      .catch((e) => {
        if (alive) {
          useWorkspace.getState().initialize();
          reportError(new Error(`无法读取本地存储：${e.message}`));
          setReady(true);
        }
      });
    const stopClock = startPreviewClock(preview);
    return () => {
      alive = false;
      stopClock();
      void preview.reset();
    };
  }, []);
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveProject().catch(reportError);
      }
    };
    const leave = (e: BeforeUnloadEvent) => {
      if (useWorkspace.getState().dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("keydown", keyboard);
    window.addEventListener("beforeunload", leave);
    return () => {
      window.removeEventListener("keydown", keyboard);
      window.removeEventListener("beforeunload", leave);
    };
  }, []);
  const selected = project?.instances.find((i) => i.instanceId === selectedId);
  const tabs = [
    { id: "assets", label: "资产", icon: Boxes },
    { id: "plc", label: "PLC", icon: FileCode2 },
    { id: "terminal", label: "终端", icon: Terminal },
  ] as const;
  if (!ready)
    return (
      <div className="boot-screen">
        <div className="brand-mark">
          <ProjectMark size={48} />
        </div>
        <h1>Agentic Components</h1>
        <p>正在打开设备工作台…</p>
      </div>
    );
  return (
    <div
      className={styles.workspace}
      style={
        {
          "--left-width": `${left}px`,
          "--right-width": `${right}px`,
        } as CSSProperties
      }
    >
      <TopBar />
      <div className={styles.main}>
        {showLeft && (
          <>
            <div className={styles.left}>
              <SceneTree />
            </div>
            <Splitter
              label="调整 BOM 宽度"
              axis="x"
              value={left}
              min={200}
              max={380}
              onChange={setLeft}
            />
          </>
        )}
        <main className={styles.viewport} aria-label="三维工作区">
          <SceneCanvas />
          <div className="viewport-top">
            <div className="viewport-toolstrip">
              <button
                className="icon-button"
                aria-label="切换 BOM"
                title="显示/折叠 BOM"
                onClick={() => setShowLeft(!showLeft)}
              >
                {showLeft ? (
                  <PanelLeftClose size={16} />
                ) : (
                  <PanelLeftOpen size={16} />
                )}
              </button>
              <TransformToolbar />
              <span className="divider" />
              <span className="tool-active" title="选择模式">
                <MousePointer2 size={16} />
              </span>
              <button
                className="icon-button"
                title="定位选中设备"
                aria-label="定位视口"
                onClick={() =>
                  useWorkspace.setState((s) => ({
                    focusToken: s.focusToken + 1,
                  }))
                }
              >
                <Crosshair size={16} />
              </button>
              <button
                className="icon-button"
                title="复位视角"
                aria-label="复位视角"
                onClick={() => {
                  useWorkspace.getState().select(null);
                  useWorkspace.setState((s) => ({
                    focusToken: s.focusToken + 1,
                  }));
                }}
              >
                <RotateCcw size={15} />
              </button>
              <span className="divider" />
              <Grid2X2 size={15} />
              <span className="viewport-scale">0.5 m</span>
            </div>
            <button
              className="icon-button panel-toggle"
              aria-label="切换设备明细"
              title="显示/折叠设备明细"
              onClick={() => setShowRight(!showRight)}
            >
              {showRight ? (
                <PanelRightClose size={16} />
              ) : (
                <PanelRightOpen size={16} />
              )}
            </button>
          </div>
          <div className="viewport-title">
            <span className="eyebrow">SCENE / 01</span>
            <span>{project?.name}</span>
            <small>
              建模工作区 <i /> Y ↑ · m
            </small>
          </div>
          <div className="viewport-footer">
            <span>
              <span className="led green" />
              透视视图
            </span>
            <span>选中后拖动坐标轴 · Esc 取消 · 空白拖动旋转视角</span>
            <span className="mock-watermark">示意资产 · 非物理仿真</span>
          </div>
        </main>
        {showRight && (
          <>
            <Splitter
              label="调整明细宽度"
              axis="x"
              reverse
              value={right}
              min={280}
              max={440}
              onChange={setRight}
            />
            <div className={styles.right}>
              <Inspector key={selectedId} />
            </div>
          </>
        )}
      </div>
      {dockOpen && (
        <Splitter
          label="调整底部面板高度"
          axis="y"
          reverse
          value={bottom}
          min={140}
          max={450}
          onChange={(v) => {
            setBottom(v);
            setMaximized(false);
          }}
        />
      )}
      <section className="bottom-dock">
        <div className="dock-tabs" role="tablist" aria-label="底部工作面板">
          {tabs.map((t) => (
            <button
              role="tab"
              aria-selected={dock === t.id && dockOpen}
              aria-controls={`panel-${t.id}`}
              id={`tab-${t.id}`}
              key={t.id}
              className={dock === t.id && dockOpen ? "active" : ""}
              onClick={() =>
                useWorkspace.setState({
                  dock: t.id,
                  dockOpen: dock === t.id ? !dockOpen : true,
                })
              }
            >
              <t.icon size={14} />
              {t.label}
              {t.id === "terminal" && <small>{logs.length}</small>}
            </button>
          ))}
          <span className="dock-caption">WORKSPACE TOOLS</span>
          <div className="dock-buttons">
            <button
              className="icon-button"
              aria-label="最大化底部面板"
              onClick={() => {
                setMaximized(!maximized);
                useWorkspace.setState({ dockOpen: true });
              }}
            >
              <PanelBottom size={14} />
            </button>
            <button
              className="icon-button"
              aria-label={dockOpen ? "折叠底部面板" : "展开底部面板"}
              onClick={() => useWorkspace.setState({ dockOpen: !dockOpen })}
            >
              {dockOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
            </button>
          </div>
        </div>
        <div
          className="dock-content"
          style={{ height: dockOpen ? (maximized ? "55vh" : bottom) : 0 }}
        >
          {tabs.map((t) => (
            <div
              role="tabpanel"
              aria-labelledby={`tab-${t.id}`}
              id={`panel-${t.id}`}
              key={t.id}
              hidden={dock !== t.id}
              className="dock-panel"
            >
              {t.id === "assets" ? (
                <AssetPanel />
              ) : t.id === "plc" ? (
                <PlcPanel />
              ) : (
                <TerminalPanel />
              )}
            </div>
          ))}
        </div>
      </section>
      <footer className="statusbar">
        <span>
          <span className={`led ${dirty ? "amber" : "green"}`} />
          {dirty ? "有未保存修改" : "本地项目"}
        </span>
        <span>{selected?.name ?? "未选择设备"}</span>
        <span className="status-spacer" />
        <span>预览 {state.status}</span>
        <span>{project?.instances.length} 个实例</span>
        <button
          onClick={() =>
            useWorkspace.setState({ dock: "terminal", dockOpen: true })
          }
        >
          <CircleAlert size={12} />
          {logs.filter((l) => l.level === "error").length} 条错误
        </button>
        <span className="version">v0.1 · WORKBENCH</span>
      </footer>
      {notice && (
        <div className="toast" role="alert">
          <CircleAlert size={17} />
          <p>{notice}</p>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => useWorkspace.setState({ notice: "" })}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

import { clearScene } from "@/commands/sceneCommands";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Eye,
  EyeOff,
  Crosshair,
  Trash2,
  Brush,
  Folder,
  FolderOpen,
} from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { DeviceIcon } from "@/components/ui/DeviceIcon";
import { removeSelected, reportError } from "@/commands/workspaceCommands";
import {
  sceneBundleAssets,
  type ScenePackageInstance,
} from "@/contracts/scene-package";
import { AssetPanel } from "@/features/catalog/AssetPanel";
import { SceneLibrary } from "./SceneLibrary";
import { SceneFolder } from "./SceneFolder";

function ProjectSceneFolder({
  scene,
  query,
  selected,
}: {
  scene: ScenePackageInstance;
  query: string;
  selected: boolean;
}) {
  const assets = useMemo(() => sceneBundleAssets(scene.bundle), [scene.bundle]);
  return (
    <SceneFolder
      scene={scene}
      name={scene.bundle.name + " · 场景"}
      searchName={scene.bundle.name + " " + scene.id}
      assets={assets}
      query={query}
      selected={selected}
      onSelect={() => useWorkspace.getState().select(scene.id)}
      onFocusScene={() =>
        useWorkspace.setState((s) => ({ focusToken: s.focusToken + 1 }))
      }
    />
  );
}

export function SceneTree() {
  const {
    project,
    selectedId,
    selectedSceneDeviceId,
    modelErrors,
    documentLocked,
  } = useWorkspace();
  const [search, setSearch] = useState("");
  const [projectOpen, setProjectOpen] = useState(
    !!project?.scenePackages?.length,
  );
  const [closedSearch, setClosedSearch] = useState("");
  useEffect(
    () =>
      useWorkspace.subscribe((state, previous) => {
        const current = state.project,
          prior = previous.project;
        if (
          current &&
          prior &&
          current.id === prior.id &&
          current.instances.length > prior.instances.length
        ) {
          setProjectOpen(true);
        }
      }),
    [],
  );
  const query = search.trim().toLowerCase();
  const open = query ? closedSearch !== query : projectOpen;
  const deviceQuery = project?.name.toLowerCase().includes(query) ? "" : query;
  return (
    <aside className="panel bom" aria-label="资产与场景">
      <AssetPanel />
      <section className="sidebar-pane scene-browser" aria-label="场景库">
        <div className="panel-heading">
          <span>场景</span>
          <div className="sidebar-heading-tools">
            <button
              type="button"
              className="icon-button"
              aria-label="清理场景"
              title={
                documentLocked
                  ? "请先停止并重置仿真"
                  : "清理当前设备、场景和连接"
              }
              disabled={
                documentLocked ||
                !project ||
                !(
                  project.instances.length ||
                  project.scenePackages?.length ||
                  project.connections?.length ||
                  project.plc
                )
              }
              onClick={() => void clearScene().catch(reportError)}
            >
              <Brush size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="定位"
              title="定位选中的现场资产"
              disabled={!selectedId || !!selectedSceneDeviceId}
              onClick={() =>
                useWorkspace.setState((s) => ({ focusToken: s.focusToken + 1 }))
              }
            >
              <Crosshair size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="移除"
              title="移除选中的现场资产"
              disabled={
                !selectedId || !!selectedSceneDeviceId || documentLocked
              }
              onClick={() => removeSelected().catch(reportError)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        <div className="search-field">
          <Search size={13} />
          <input
            aria-label="搜索场景"
            placeholder="搜索场景或设备…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="sidebar-pane-body">
          <section className="asset-tree-group" aria-label="当前项目">
            <button
              className="scene-folder-toggle project-folder-toggle"
              aria-expanded={open}
              onClick={() =>
                query
                  ? setClosedSearch(open ? query : "")
                  : setProjectOpen(!open)
              }
            >
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {open ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span>{project?.name}</span>
            </button>
            <div className="asset-tree-branches" hidden={!open}>
              {project?.instances
                .filter((i) =>
                  `${i.name} ${i.instanceId}`
                    .toLowerCase()
                    .includes(deviceQuery),
                )
                .map((i) => {
                  const def = project.definitions.find(
                    (d) => d.specId === i.specId,
                  );
                  return (
                    <div
                      className={`tree-row ${selectedId === i.instanceId ? "selected" : ""} ${!i.visible ? "hidden-object" : ""}`}
                      key={i.instanceId}
                    >
                      <button
                        className="tree-select"
                        onClick={() =>
                          useWorkspace.getState().select(i.instanceId)
                        }
                        onDoubleClick={() =>
                          useWorkspace.setState((s) => ({
                            focusToken: s.focusToken + 1,
                          }))
                        }
                      >
                        <DeviceIcon type={def?.deviceType} size={16} />
                        <span>{i.name}</span>
                        {modelErrors[i.instanceId] && (
                          <span
                            className="warning-text"
                            title={modelErrors[i.instanceId]}
                          >
                            !
                          </span>
                        )}
                      </button>
                      <button
                        className="icon-button visibility"
                        disabled={documentLocked}
                        aria-label={`${i.visible ? "隐藏" : "显示"} ${i.name}`}
                        onClick={() =>
                          useWorkspace.getState().updateInstance(i.instanceId, {
                            visible: !i.visible,
                          })
                        }
                      >
                        {i.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                      </button>
                    </div>
                  );
                })}
              {project?.instances.length === 0 && (
                <div className="empty-state">此场景暂无独立设备</div>
              )}
            </div>
          </section>
          {project?.scenePackages?.map((scene) => (
            <ProjectSceneFolder
              key={scene.id}
              scene={scene}
              query={query}
              selected={selectedId === scene.id && !selectedSceneDeviceId}
            />
          ))}
          <SceneLibrary query={query} />
        </div>
      </section>
    </aside>
  );
}

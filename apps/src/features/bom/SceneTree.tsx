import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Eye,
  EyeOff,
  Crosshair,
  Trash2,
  Layers3,
} from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { DeviceIcon } from "@/components/ui/DeviceIcon";
import { removeSelected, reportError } from "@/commands/workspaceCommands";
export function SceneTree() {
  const { project, selectedId, modelErrors } = useWorkspace();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(true);
  return (
    <aside className="panel bom">
      <div className="panel-heading">
        <span>
          现场资产 <small>BOM</small>
        </span>
        <span className="count">{project?.instances.length ?? 0}</span>
      </div>
      <div className="search-field">
        <Search size={14} />
        <input
          aria-label="搜索现场资产"
          placeholder="搜索名称或 ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <kbd>⌕</kbd>
      </div>
      <button
        className="tree-root"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Layers3 size={15} />
        <span>{project?.name}</span>
      </button>
      <div className="tree-list">
        {open &&
          project?.instances
            .filter((i) =>
              `${i.name} ${i.instanceId}`
                .toLowerCase()
                .includes(search.toLowerCase()),
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
                    onClick={() => useWorkspace.getState().select(i.instanceId)}
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
                    aria-label={`${i.visible ? "隐藏" : "显示"} ${i.name}`}
                    onClick={() =>
                      useWorkspace
                        .getState()
                        .updateInstance(i.instanceId, { visible: !i.visible })
                    }
                  >
                    {i.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                </div>
              );
            })}
        {project?.instances.length === 0 && (
          <div className="empty-state">
            从底部资产库添加设备
            <br />
            开始搭建你的工作站
          </div>
        )}
      </div>
      <div className="bom-bottom">
        <div>
          <span className="led green" /> 场景文档{" "}
          <small>
            {project?.instances.filter((i) => i.visible).length} 个可见实例
          </small>
        </div>
        <div className="row">
          <button
            disabled={!selectedId}
            title="聚焦选中设备"
            onClick={() =>
              useWorkspace.setState((s) => ({ focusToken: s.focusToken + 1 }))
            }
          >
            <Crosshair size={14} />
            定位
          </button>
          <button
            disabled={!selectedId}
            onClick={() => removeSelected().catch(reportError)}
          >
            <Trash2 size={14} />
            移除
          </button>
        </div>
      </div>
    </aside>
  );
}

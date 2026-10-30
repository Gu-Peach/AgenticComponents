import { useState } from "react";
import { Search, Plus, ArrowUpRight, Upload } from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { DeviceIcon } from "@/components/ui/DeviceIcon";
import { typeLabels } from "@/contracts/device";
import {
  importDefinition,
  reportError,
  refreshPublicCatalog,
  selectPublicAsset,
  addPublicAsset,
} from "@/commands/workspaceCommands";
export function AssetPanel() {
  const {
    project,
    selectedAsset,
    publicEntries,
    catalogDefinitions,
    catalogStatus,
    catalogError,
    addingAsset,
  } = useWorkspace();
  const definitions = [
    ...(project?.definitions ?? []),
    ...publicEntries
      .filter((e) => !project?.definitions.some((d) => d.specId === e.specId))
      .map(
        (e) =>
          catalogDefinitions[e.specId] ?? {
            specId: e.specId,
            name: e.name,
            deviceType: e.deviceType,
            template: false,
            asset: { sourceUrl: e.modelUrl },
            paramsSchema: {},
            behaviors: [],
          },
      ),
  ];
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const selected = definitions.find((d) => d.specId === selectedAsset);
  const add = (id: string) => {
    const e = publicEntries.find((e) => e.specId === id);
    if (e) void addPublicAsset(e).catch(reportError);
    else {
      const d = project?.definitions.find((d) => d.specId === id);
      if (d) useWorkspace.getState().add(d);
    }
  };
  return (
    <div className="asset-panel">
      <div className="asset-toolbar">
        <div className="segmented">
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            全部资产 <small>{definitions.length}</small>
          </button>
          <button
            className={filter === "equipment" ? "active" : ""}
            onClick={() => setFilter("equipment")}
          >
            设备
          </button>
          <button
            className={filter === "material" ? "active" : ""}
            onClick={() => setFilter("material")}
          >
            物料与载具
          </button>
        </div>
        <div className="search-field compact">
          <Search size={14} />
          <input
            aria-label="搜索资产目录"
            placeholder="搜索资产…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          onClick={() => void refreshPublicCatalog()}
          disabled={catalogStatus === "loading"}
        >
          刷新目录
        </button>
        {catalogError && (
          <span role="alert" className="error-text">
            {catalogError}
          </span>
        )}
        <select
          aria-label="导入已有样例"
          value=""
          onChange={async (e) => {
            const file = e.target.value;
            if (!file) return;
            try {
              const r = await fetch(`/catalog/examples/${file}.json`);
              if (!r.ok) throw new Error("样例读取失败");
              await importDefinition(await r.json());
            } catch (e) {
              reportError(e);
            }
          }}
        >
          <option value="">＋ 导入现有样例</option>
          <option value="conveyor_1">传送带 DeviceSpec</option>
          <option value="robot_arm_1">机械臂 DeviceSpec</option>
          <option value="carrier_tray_1">托盘 DeviceSpec</option>
          <option value="workpiece_1">物料 DeviceSpec</option>
        </select>
      </div>
      <div className="asset-body">
        <div className="asset-grid">
          {definitions
            .filter(
              (d) =>
                d.name.includes(search) ||
                d.deviceType.includes(search.toLowerCase()),
            )
            .filter(
              (d) =>
                filter === "all" ||
                (filter === "material") ===
                  ["workpiece", "workpiece_carrier"].includes(d.deviceType),
            )
            .map((d) => (
              <button
                key={d.specId}
                className={`asset-card ${selectedAsset === d.specId ? "selected" : ""}`}
                onClick={() => {
                  const e = publicEntries.find((e) => e.specId === d.specId);
                  if (e) void selectPublicAsset(e).catch(reportError);
                  else useWorkspace.getState().selectAsset(d.specId);
                }}
                onDoubleClick={() => add(d.specId)}
              >
                <div className={`asset-art art-${d.deviceType}`}>
                  <span className="asset-grid-pattern" />
                  <DeviceIcon type={d.deviceType} size={38} />
                  <ArrowUpRight size={12} className="asset-arrow" />
                </div>
                <strong>{d.name}</strong>
                <small>
                  {d.template
                    ? "待配置模板"
                    : d.asset.sourceUrl
                      ? "公共模型"
                      : d.asset.assetId
                        ? "已关联模型"
                        : "模型未关联"}
                </small>
              </button>
            ))}
        </div>
        <div className="asset-summary">
          {selected ? (
            <>
              <div className="eyebrow">ASSET DEFINITION</div>
              <h3>
                <DeviceIcon type={selected.deviceType} />
                {selected.name}
              </h3>
              <code>{selected.specId}</code>
              <p>
                {typeLabels[selected.deviceType]} ·{" "}
                {Object.keys(selected.paramsSchema).length} 个参数 ·{" "}
                {selected.behaviors.length} 个行为
              </p>
              <span className="pill warning">
                {selected.template ? "模板 · 需完善契约" : "执行器待接入"}
              </span>
              <button
                className="primary"
                disabled={Boolean(addingAsset)}
                onClick={() => add(selected.specId)}
              >
                <Plus size={15} />
                添加到现场
              </button>
            </>
          ) : (
            <p>
              <Upload size={18} />
              选择资产查看定义
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

import { useId, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import type { CatalogEntry } from "@/contracts/catalog";
import {
  deviceTypes,
  typeLabels,
  type DeviceDefinition,
  type DeviceType,
} from "@/contracts/device";
import { DeviceIcon } from "@/components/ui/DeviceIcon";
import { useWorkspace } from "@/stores/workspace";
import {
  addPublicAsset,
  importDefinition,
  refreshPublicCatalog,
  reportError,
  selectPublicAsset,
} from "@/commands/workspaceCommands";

const categories = deviceTypes.filter((type) => type !== "workpiece_carrier");

type Asset = Pick<DeviceDefinition, "specId" | "name" | "deviceType"> & {
  status: string;
  definition?: DeviceDefinition;
  entry?: CatalogEntry;
};

function categoryOf(type: DeviceType) {
  return type === "workpiece_carrier" ? "workpiece" : type;
}

function catalogAssets(
  definitions: DeviceDefinition[],
  entries: CatalogEntry[],
) {
  const assets = new Map<string, Asset>();
  for (const definition of definitions) {
    const { specId, name, deviceType, asset, template } = definition;
    const status = template
      ? "待配置模板"
      : asset.sourceUrl
        ? "公共模型"
        : asset.assetId
          ? "已关联模型"
          : "模型未关联";
    assets.set(specId, { specId, name, deviceType, definition, status });
  }
  for (const entry of entries) {
    const existing = assets.get(entry.specId);
    if (existing) existing.entry = entry;
    else assets.set(entry.specId, { ...entry, entry, status: "公共模型" });
  }
  return [...assets.values()];
}

async function importExample(file: string) {
  const project = useWorkspace.getState().project;
  const response = await fetch(`/catalog/examples/${file}.json`);
  if (!response.ok) throw new Error("样例读取失败");
  const definition: unknown = await response.json();
  if (useWorkspace.getState().project !== project)
    throw new Error("项目已改变，请重新导入样例");
  await importDefinition(definition);
}

function AssetFolder({
  name,
  assets,
  query,
  selected,
  select,
  add,
}: {
  name: string;
  assets: Asset[];
  query: string;
  selected: string | null;
  select(asset: Asset): void;
  add(asset: Asset): void;
}) {
  const [open, setOpen] = useState(false);
  const [closedSearch, setClosedSearch] = useState("");
  const listId = useId();
  const expanded = query ? closedSearch !== query : open;
  if (query && !assets.length) return null;
  return (
    <div className="asset-category">
      <button
        className="asset-folder-toggle"
        aria-label={name}
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() =>
          query ? setClosedSearch(expanded ? query : "") : setOpen(!open)
        }
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
        <span>{name}</span>
        <small className="folder-count">{assets.length}</small>
      </button>
      {expanded && (
        <div
          className="asset-type-items"
          id={listId}
          role="group"
          aria-label={name + "列表"}
        >
          {assets.map((asset) => (
            <div
              key={asset.specId}
              className={`tree-row${selected === asset.specId ? " selected" : ""}`}
            >
              <button
                className="tree-select"
                aria-label={asset.name}
                aria-pressed={selected === asset.specId}
                title={`${asset.name} · ${asset.specId} · ${asset.status}`}
                onClick={() => select(asset)}
                onDoubleClick={() => add(asset)}
              >
                <DeviceIcon type={asset.deviceType} size={15} />
                <span>{asset.name}</span>
                <small className="asset-kind">{asset.status}</small>
              </button>
            </div>
          ))}
          {!assets.length && <p className="scene-tree-message">暂无资产</p>}
        </div>
      )}
    </div>
  );
}

export function AssetPanel() {
  const {
    project,
    selectedAsset,
    inspectorTarget,
    publicEntries,
    catalogStatus,
    catalogError,
    documentLocked,
    addingAsset,
  } = useWorkspace();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const assets = catalogAssets(project?.definitions ?? [], publicEntries);
  const selected =
    inspectorTarget === "catalog"
      ? assets.find((asset) => asset.specId === selectedAsset)
      : undefined;
  const matches = query
    ? assets.filter((asset) =>
        [
          asset.name,
          asset.specId,
          asset.deviceType,
          typeLabels[categoryOf(asset.deviceType)],
        ].some((value) => value.toLowerCase().includes(query)),
      )
    : assets;
  function select(asset: Asset) {
    if (asset.entry) void selectPublicAsset(asset.entry).catch(reportError);
    else useWorkspace.getState().selectAsset(asset.specId);
  }
  function add(asset: Asset) {
    if (
      useWorkspace.getState().documentLocked ||
      useWorkspace.getState().addingAsset
    )
      return;
    if (asset.entry) void addPublicAsset(asset.entry).catch(reportError);
    else if (asset.definition) useWorkspace.getState().add(asset.definition);
  }
  return (
    <section className="sidebar-pane asset-library" aria-label="资产库">
      <div className="panel-heading">
        <span>资产</span>
        <button
          className="icon-button"
          aria-label="刷新资产目录"
          title="刷新资产目录"
          disabled={catalogStatus === "loading"}
          onClick={() => void refreshPublicCatalog()}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <label className="search-field">
        <Search size={13} />
        <input
          aria-label="搜索资产目录"
          placeholder="搜索资产名称或 ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="sidebar-pane-body">
        {catalogError && (
          <p role="alert" className="scene-tree-message">
            {catalogError}
          </p>
        )}
        <div hidden={!!query}>
          <AssetFolder
            name="全部资产"
            assets={assets}
            query=""
            selected={selected?.specId ?? null}
            select={select}
            add={add}
          />
        </div>
        {categories.map((type) => (
          <AssetFolder
            key={type}
            name={typeLabels[type]}
            assets={matches.filter(
              (asset) => categoryOf(asset.deviceType) === type,
            )}
            query={query}
            selected={selected?.specId ?? null}
            select={select}
            add={add}
          />
        ))}
        {query && !matches.length && (
          <p className="scene-tree-message">没有匹配的资产</p>
        )}
      </div>
      <div className="asset-library-actions">
        <select
          aria-label="导入已有样例"
          title="导入已有样例"
          value=""
          disabled={documentLocked || !project}
          onChange={(e) => {
            if (e.target.value)
              void importExample(e.target.value).catch(reportError);
          }}
        >
          <option value="">导入样例</option>
          <option value="conveyor_1">传送带 DeviceSpec</option>
          <option value="robot_arm_1">机械臂 DeviceSpec</option>
          <option value="carrier_tray_1">托盘 DeviceSpec</option>
          <option value="workpiece_1">物料 DeviceSpec</option>
        </select>
        <button
          disabled={!selected || !!addingAsset || documentLocked}
          title={selected?.name}
          onClick={() => {
            if (selected) add(selected);
          }}
        >
          <Plus size={13} />
          {addingAsset ? "正在添加…" : "添加到现场"}
        </button>
      </div>
    </section>
  );
}

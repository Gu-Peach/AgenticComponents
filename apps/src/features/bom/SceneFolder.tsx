import { useId, useMemo, useState, type ReactNode } from "react";
import {
  Box,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  sceneMeshOwners,
  type SceneAsset,
  type ScenePackageInstance,
} from "@/contracts/scene-package";
import { useWorkspace } from "@/stores/workspace";
import { icons, DeviceIcon } from "@/components/ui/DeviceIcon";
import { typeLabels, type DeviceType } from "@/contracts/device";

function assetType(type: string) {
  return Object.hasOwn(icons, type) ? (type as DeviceType) : undefined;
}

function matchesAsset(asset: SceneAsset, query: string) {
  const type = assetType(asset.type);
  return [asset.id, asset.name, asset.type, type && typeLabels[type]].some(
    (value) => value?.toLowerCase().includes(query),
  );
}

export function matchesScene(
  name: string,
  assets: readonly SceneAsset[] | undefined,
  query: string,
) {
  return (
    name.toLowerCase().includes(query) ||
    !!assets?.some((asset) => matchesAsset(asset, query))
  );
}

interface SceneFolderProps {
  name: string;
  query: string;
  assets?: readonly SceneAsset[];
  scene?: ScenePackageInstance;
  loadAssets?: () => Promise<void>;
  searchName?: string;
  selected?: boolean;
  onSelect?: () => void;
  onFocusScene?: () => void;
  children?: ReactNode;
}

export function SceneFolder({
  name,
  query,
  assets,
  scene,
  loadAssets,
  searchName = name,
  selected,
  onSelect,
  onFocusScene,
  children,
}: SceneFolderProps) {
  const [expanded, setExpanded] = useState(false);
  const [searchToggle, setSearchToggle] = useState<{
    query: string;
    open: boolean;
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const contentId = useId();
  const selectedDevice = useWorkspace((s) =>
    scene && s.selectedId === scene.id ? s.selectedSceneDeviceId : null,
  );
  const locked = useWorkspace((s) => s.documentLocked);
  const bundle = scene?.bundle;
  const boundDevices = useMemo(
    () => bundle && new Set(sceneMeshOwners(bundle).values()),
    [bundle],
  );

  function toggleDevice(id: string) {
    if (!scene || locked) return;
    useWorkspace.getState().updateProject((p) => ({
      ...p,
      scenePackages: p.scenePackages?.map((item) => {
        if (item.id !== scene.id) return item;
        const hidden = item.hiddenDeviceIds ?? [];
        return {
          ...item,
          hiddenDeviceIds: hidden.includes(id)
            ? hidden.filter((key) => key !== id)
            : [...hidden, id],
        };
      }),
    }));
  }
  const childSearch = !!query && !searchName.toLowerCase().includes(query);
  const visible = childSearch
    ? assets?.filter((asset) => matchesAsset(asset, query))
    : assets;
  const open = childSearch
    ? searchToggle?.query === query
      ? searchToggle.open
      : true
    : expanded;

  async function loadContents() {
    if (!loadAssets || assets || loading) return;
    setLoading(true);
    setError("");
    try {
      await loadAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  if (!matchesScene(searchName, assets, query)) return null;
  return (
    <div className="scene-folder">
      <button
        className={`scene-folder-toggle${selected ? " selected" : ""}`}
        aria-label={name}
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        title={name}
        onClick={() => {
          onSelect?.();
          if (childSearch) setSearchToggle({ query, open: !open });
          else setExpanded(!open);
          if (!open) void loadContents();
        }}
        onDoubleClick={onFocusScene}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {open ? <FolderOpen size={15} /> : <Folder size={15} />}
        <span>{scene?.bundle.name ?? name}</span>
      </button>
      {open && (
        <div id={contentId} className="scene-folder-contents">
          {error ? (
            <div className="scene-tree-message" role="alert">
              {error} <button onClick={() => void loadContents()}>重试</button>
            </div>
          ) : !assets ? (
            <p className="scene-tree-message" role="status">
              正在读取资产…
            </p>
          ) : (
            <ul className="scene-assets" aria-label={`${name}的资产`}>
              {visible?.map((asset) => {
                const type = assetType(asset.type);
                const hidden = !!scene?.hiddenDeviceIds?.includes(asset.id);
                const content = (
                  <>
                    {type ? (
                      <DeviceIcon type={type} size={16} />
                    ) : (
                      <Box size={16} />
                    )}
                    <span>
                      {asset.name.split(/[：:]/, 1)[0] ||
                        (type && typeLabels[type]) ||
                        asset.type}
                    </span>
                    <small className="scene-device-id">{asset.id}</small>
                  </>
                );
                return (
                  <li
                    key={asset.id}
                    title={asset.id + " · " + asset.name}
                    className={`tree-row scene-device-row${selectedDevice === asset.id ? " selected" : ""}${hidden ? " hidden-object" : ""}`}
                  >
                    {scene ? (
                      <>
                        <button
                          className="tree-select"
                          aria-label={`选择 ${asset.id}`}
                          aria-pressed={selectedDevice === asset.id}
                          onClick={() =>
                            useWorkspace.getState().select(scene.id, asset.id)
                          }
                        >
                          {content}
                        </button>
                        <button
                          className="icon-button visibility"
                          disabled={locked || !boundDevices?.has(asset.id)}
                          title={
                            !boundDevices?.has(asset.id)
                              ? "尚未绑定模型网格"
                              : undefined
                          }
                          aria-label={`${hidden ? "显示" : "隐藏"} ${asset.id}`}
                          onClick={() => toggleDevice(asset.id)}
                        >
                          {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </>
                    ) : (
                      <div className="tree-select scene-device-preview">
                        {content}
                      </div>
                    )}
                  </li>
                );
              })}
              {assets.length === 0 && (
                <li className="scene-tree-message">暂无资产</li>
              )}
            </ul>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FolderTree, Import } from "lucide-react";
import type { SceneEntry } from "@/contracts/scene-package";
import {
  fetchSceneAssets,
  fetchSceneCatalog,
  importScenePackage,
} from "@/services/PublicSceneCatalog";
import { useWorkspace } from "@/stores/workspace";
import { matchesScene, SceneFolder } from "./SceneFolder";

export function SceneLibrary({ query }: { query: string }) {
  const locked = useWorkspace((s) => s.documentLocked);
  const [entries, setEntries] = useState<SceneEntry[]>();
  const [open, setOpen] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [catalogError, setCatalogError] = useState("");
  const [importError, setImportError] = useState<{
    id: string;
    message: string;
  }>();
  const [adding, setAdding] = useState<string>();
  useEffect(() => {
    let active = true;
    fetchSceneCatalog().then(
      (data) => {
        if (active) setEntries(data);
      },
      (cause) => {
        if (active)
          setCatalogError(
            cause instanceof Error ? cause.message : String(cause),
          );
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  async function importScene(entry: SceneEntry) {
    if (adding || locked) return;
    setAdding(entry.id);
    setImportError(undefined);
    try {
      await importScenePackage(entry);
    } catch (cause) {
      setImportError({
        id: entry.id,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setAdding(undefined);
    }
  }

  return (
    <div className="asset-tree-group scene-library">
      <button
        className="tree-root"
        aria-label="可导入场景"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <FolderTree size={15} />
        <span>可导入场景</span>
        {entries && <small className="folder-count">{entries.length}</small>}
      </button>
      <div className="asset-tree-branches" hidden={!open}>
        {catalogError ? (
          <div className="scene-tree-message" role="alert">
            {catalogError}{" "}
            <button
              onClick={() => {
                setCatalogError("");
                setAttempt((n) => n + 1);
              }}
            >
              重试
            </button>
          </div>
        ) : (
          !entries && (
            <p className="scene-tree-message" role="status">
              正在读取场景目录…
            </p>
          )
        )}
        {entries?.map((entry) => (
          <SceneFolder
            key={entry.id}
            name={entry.name}
            searchName={entry.id + " " + entry.name}
            query={query}
            assets={entry.assets}
            loadAssets={async () => {
              const assets = await fetchSceneAssets(entry);
              setEntries((current) =>
                current?.map((row) =>
                  row.id === entry.id ? { ...row, assets } : row,
                ),
              );
            }}
          >
            <button
              className="scene-import"
              aria-label={`导入 ${entry.id} 整场景`}
              disabled={!!adding || locked}
              title={
                locked
                  ? "请先停止运行再导入场景"
                  : `${entry.deviceCount} 个资产 · ${entry.nodeCount} 个模型节点 · ${entry.blockerCount} 项绑定/运行依赖待完成`
              }
              onClick={() => void importScene(entry)}
            >
              <Import size={13} />
              {adding === entry.id ? "正在导入…" : "导入整场景"}
            </button>
            {importError?.id === entry.id && (
              <p className="scene-tree-message" role="alert">
                {importError.message}
              </p>
            )}
          </SceneFolder>
        ))}
        {entries &&
          !entries.some((entry) =>
            matchesScene(entry.id + " " + entry.name, entry.assets, query),
          ) && (
            <p className="scene-tree-message">
              {query ? "没有匹配的场景或资产" : "暂无场景"}
            </p>
          )}
      </div>
    </div>
  );
}

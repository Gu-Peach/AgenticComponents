import { useEffect, useState } from "react";
import type { SceneEntry } from "@/contracts/scene-package";
import {
  fetchSceneCatalog,
  importScenePackage,
} from "@/services/PublicSceneCatalog";

export function SceneCatalogPanel({ search }: { search: string }) {
  const [entries, setEntries] = useState<SceneEntry[]>([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState("");
  useEffect(() => {
    let active = true;
    fetchSceneCatalog()
      .then((e) => {
        if (active) setEntries(e);
      })
      .catch((e) => {
        if (active) setError(String(e.message));
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="asset-body">
      <div className="asset-grid">
        {error && <p role="alert">{error}</p>}
        {!entries.length && !error && <p>正在读取场景目录…</p>}
        {entries
          .filter((entry) =>
            `${entry.id} ${entry.name}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((entry) => (
            <button
              className="asset-card"
              key={entry.id}
              disabled={Boolean(adding)}
              onClick={async () => {
                setAdding(entry.id);
                setError("");
                try {
                  await importScenePackage(entry);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setAdding("");
                }
              }}
            >
              <strong>{entry.name}</strong>
              <small>
                {entry.deviceCount} 个资产 · {entry.nodeCount} 个模型节点
              </small>
              <span>{adding === entry.id ? "正在导入…" : "导入整场景"}</span>
              <small>{entry.blockerCount} 项绑定/运行依赖待完成</small>
            </button>
          ))}
      </div>
    </div>
  );
}

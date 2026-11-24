import { useWorkspace } from "@/stores/workspace";
import type { AssetRecord, ProjectDocument } from "@/contracts/device";
import { parseProject } from "@/validation/contracts";
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("agentic-workbench", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("project");
      request.result.createObjectStore("assets");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = run(tx.objectStore(store));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("浏览器存储操作失败"));
    };
  });
}
// Unsaved extracted blobs share the lifetime of their document's asset records.
const draftBlobs = new WeakMap<AssetRecord, Blob>();
type DraftAsset = { record: AssetRecord; blob: Blob };

async function writeAssetsAtomic(
  entries: DraftAsset[],
  project?: ProjectDocument,
) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        project ? ["assets", "project"] : ["assets"],
        "readwrite",
      );
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("模型写入已中止"));
      // Let request errors abort the whole transaction. Existing content-addressed blobs stay shared.
      const assets = tx.objectStore("assets");
      try {
        for (const { record, blob } of entries) {
          const lookup = assets.count(record.id);
          lookup.onsuccess = () => {
            if (!lookup.result) assets.add(blob, record.id);
          };
        }
        if (project) tx.objectStore("project").put(project, "current");
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
    for (const { record, blob } of entries)
      if (draftBlobs.get(record) === blob) draftBlobs.delete(record);
  } finally {
    db.close();
  }
}

function pendingAssets(project: ProjectDocument): DraftAsset[] {
  return project.assets.flatMap((record) => {
    const blob = draftBlobs.get(record);
    return blob ? [{ record, blob }] : [];
  });
}

export const projectRepository = {
  async load() {
    const value = await transaction("project", "readonly", (s) =>
      s.get("current"),
    );
    return value ? parseProject(value) : null;
  },
  async save(project: ProjectDocument) {
    const pending = pendingAssets(project);
    if (pending.length) return writeAssetsAtomic(pending, project);
    await transaction("project", "readwrite", (s) => s.put(project, "current"));
  },
  stageAssets(entries: DraftAsset[]) {
    for (const { record, blob } of entries)
      if (!/^sha256-[a-f0-9]{64}$/.test(record.id) || blob.size !== record.size)
        throw new Error("提取的模型与项目资产记录不匹配");
    for (const { record, blob } of entries) draftBlobs.set(record, blob);
  },
  async persistDraftAssets(project: ProjectDocument) {
    const pending = pendingAssets(project);
    if (pending.length) await writeAssetsAtomic(pending);
  },
  async putAsset(id: string, blob: Blob) {
    await transaction("assets", "readwrite", (s) => s.put(blob, id));
  },
  async getAsset(
    id: string,
    project = useWorkspace.getState().project,
  ): Promise<Blob | undefined> {
    const record = project?.assets.find((a) => a.id === id);
    const draft = record && draftBlobs.get(record);
    if (draft) return draft;
    return transaction("assets", "readonly", (s) => s.get(id));
  },
};
export function download(
  name: string,
  value: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

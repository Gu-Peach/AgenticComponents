import type { ProjectDocument } from "@/contracts/device";
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
export const projectRepository = {
  async load() {
    const value = await transaction("project", "readonly", (s) =>
      s.get("current"),
    );
    return value ? parseProject(value) : null;
  },
  async save(project: ProjectDocument) {
    await transaction("project", "readwrite", (s) => s.put(project, "current"));
  },
  async putAsset(id: string, blob: Blob) {
    await transaction("assets", "readwrite", (s) => s.put(blob, id));
  },
  async getAsset(id: string): Promise<Blob | undefined> {
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

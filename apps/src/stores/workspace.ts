import { create } from "zustand";
import { createDemoProject, instantiate } from "@/domain/catalog";
import type {
  DeviceDefinition,
  DeviceInstance,
  ProjectDocument,
} from "@/contracts/device";
export interface LogEntry {
  id: number;
  time: string;
  level: "info" | "error" | "warning";
  message: string;
}
interface WorkspaceState {
  project: ProjectDocument | null;
  selectedId: string | null;
  selectedAsset: string | null;
  dock: "assets" | "plc" | "terminal";
  dockOpen: boolean;
  dirty: boolean;
  saving: boolean;
  notice: string;
  documentLocked: boolean;
  logs: LogEntry[];
  focusToken: number;
  modelNodes: Record<string, string[]>;
  modelErrors: Record<string, string>;
  initialize(project?: ProjectDocument): void;
  select(id: string | null): void;
  updateProject(fn: (p: ProjectDocument) => ProjectDocument): void;
  updateInstance(id: string, patch: Partial<DeviceInstance>): void;
  add(def: DeviceDefinition): void;
  log(message: string, level?: LogEntry["level"]): void;
}
let logId = 0;
export const useWorkspace = create<WorkspaceState>((set, get) => ({
  project: null,
  selectedId: null,
  selectedAsset: null,
  dock: "assets",
  dockOpen: true,
  dirty: false,
  saving: false,
  notice: "",
  documentLocked: false,
  logs: [],
  focusToken: 0,
  modelNodes: {},
  modelErrors: {},
  initialize(project = createDemoProject()) {
    set({
      project,
      selectedId: project.instances[0]?.instanceId ?? null,
      selectedAsset: project.definitions[0]?.specId ?? null,
      dirty: false,
      modelErrors: {},
      modelNodes: {},
    });
  },
  select(id) {
    set({ selectedId: id });
  },
  updateProject(fn) {
    if (get().documentLocked) {
      get().log("请先停止预览再编辑场景文档", "warning");
      return;
    }
    const p = get().project;
    if (p)
      set({ project: { ...fn(p), revision: p.revision + 1 }, dirty: true });
  },
  updateInstance(id, patch) {
    get().updateProject((p) => ({
      ...p,
      instances: p.instances.map((i) =>
        i.instanceId === id ? { ...i, ...patch } : i,
      ),
    }));
  },
  add(def) {
    const p = get().project;
    if (!p || get().documentLocked) return;
    const item = instantiate(def, p.instances.length);
    get().updateProject((p) => ({ ...p, instances: [...p.instances, item] }));
    set({ selectedId: item.instanceId });
    get().log(`添加实例 ${item.name}`);
  },
  log(message, level = "info") {
    set((s) => ({
      logs: [
        ...s.logs.slice(-499),
        {
          id: ++logId,
          time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
          level,
          message,
        },
      ],
      notice: level === "error" ? message : s.notice,
    }));
  },
}));

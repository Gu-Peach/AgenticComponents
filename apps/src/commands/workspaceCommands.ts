import { useWorkspace } from "@/stores/workspace";
import { preview } from "@/runtime/services";
import {
  projectRepository,
  download,
} from "@/services/BrowserProjectRepository";
import { normalizeDeviceSpec } from "@/domain/normalizeDeviceSpec";
import { parseProject } from "@/validation/contracts";
import { ZodError } from "zod";
export async function saveProject() {
  const { project } = useWorkspace.getState();
  if (!project) return;
  useWorkspace.setState({ saving: true });
  try {
    await projectRepository.save(project);
    useWorkspace.setState((s) => ({
      dirty:
        s.project?.revision !== project.revision ||
        s.project?.id !== project.id,
    }));
    useWorkspace.getState().log("项目已保存到此浏览器（含已导入模型）");
  } finally {
    useWorkspace.setState({ saving: false });
  }
}
export function exportProject() {
  const { project, log } = useWorkspace.getState();
  if (!project) return;
  download(`${project.name}.json`, JSON.stringify(project, null, 2));
  log("已导出项目数据 JSON；不含模型文件，跨浏览器需重新关联 GLB");
}
export async function newProject() {
  if (
    useWorkspace.getState().dirty &&
    !window.confirm("当前项目有未保存修改，仍要新建吗？")
  )
    return;
  await preview.reset();
  useWorkspace.getState().initialize();
  useWorkspace.setState((s) => ({
    project: {
      ...s.project!,
      id: crypto.randomUUID(),
      name: "未命名项目",
      instances: [],
      plc: "",
    },
    selectedId: null,
    dirty: true,
  }));
}
export async function importProject(file: File) {
  const project = parseProject(JSON.parse(await file.text()));
  if (
    useWorkspace.getState().dirty &&
    !window.confirm("导入将替换当前未保存项目，继续吗？")
  )
    return;
  await preview.reset();
  useWorkspace.getState().initialize(project);
  useWorkspace.setState({ dirty: true });
  useWorkspace
    .getState()
    .log("项目数据已导入；模型文件按本地资源 ID 恢复，缺失时请重新关联");
}
export async function importDefinition(raw: unknown) {
  const def = normalizeDeviceSpec(raw);
  const state = useWorkspace.getState();
  if (state.documentLocked) throw new Error("请先停止预览再导入设备定义");
  if (state.project?.definitions.some((d) => d.specId === def.specId))
    throw new Error(`定义 ${def.specId} 已存在，请使用新 ID 或先移除旧定义`);
  state.updateProject((p) => ({ ...p, definitions: [...p.definitions, def] }));
  useWorkspace.setState({
    selectedAsset: def.specId,
    dock: "assets",
    dockOpen: true,
  });
  state.log(`已导入设备定义 ${def.name}，模型与执行器需另行关联`);
}
export async function associateGlb(file: File) {
  const state = useWorkspace.getState();
  const p = state.project;
  const instance = p?.instances.find((i) => i.instanceId === state.selectedId);
  if (!instance || !p)
    throw new Error("请先选择现场设备，GLB 将关联至其设备定义");
  if (file.size > 100 * 1024 * 1024)
    throw new Error("首期支持最大 100 MB 的 GLB");
  const bytes = await file.arrayBuffer();
  const header = new DataView(bytes);
  if (
    bytes.byteLength < 20 ||
    header.getUint32(0, true) !== 0x46546c67 ||
    header.getUint32(4, true) !== 2 ||
    header.getUint32(8, true) !== bytes.byteLength
  )
    throw new Error("不是有效的 GLB 2.0 文件");
  const length = header.getUint32(12, true);
  if (
    header.getUint32(16, true) !== 0x4e4f534a ||
    20 + length > bytes.byteLength
  )
    throw new Error("GLB JSON 数据块无效");
  const data = JSON.parse(
    new TextDecoder().decode(bytes.slice(20, 20 + length)),
  );
  for (const entry of [...(data.buffers ?? []), ...(data.images ?? [])])
    if (entry.uri && !entry.uri.startsWith("data:"))
      throw new Error("请使用资源嵌入式 GLB，不支持外部纹理或 buffer 路径");
  await preview.reset();
  if (useWorkspace.getState().project !== p)
    throw new Error("场景已改变，请重新关联");
  const id = crypto.randomUUID();
  await projectRepository.putAsset(
    id,
    new Blob([bytes], { type: "model/gltf-binary" }),
  );
  if (useWorkspace.getState().project !== p)
    throw new Error("存储模型时场景已改变，请重新关联");
  state.updateProject((p) => ({
    ...p,
    definitions: p.definitions.map((d) =>
      d.specId === instance.specId
        ? { ...d, asset: { ...d.asset, assetId: id } }
        : d,
    ),
    assets: [
      ...p.assets,
      { id, name: file.name, kind: "glb", size: file.size },
    ],
  }));
  state.log(
    `已为 ${instance.name} 的定义关联 ${file.name}；同定义实例共享此模型`,
  );
}
export async function removeSelected() {
  const id = useWorkspace.getState().selectedId;
  if (!id) return;
  await preview.reset();
  useWorkspace.getState().updateProject((p) => ({
    ...p,
    instances: p.instances.filter((i) => i.instanceId !== id),
  }));
  useWorkspace.getState().select(null);
}
export const commandRegistry = {
  save: { label: "保存到浏览器", run: saveProject },
  export: { label: "导出项目数据", run: exportProject },
  new: { label: "新建项目", run: newProject },
  focus: {
    label: "定位选中设备",
    run: () => useWorkspace.setState((s) => ({ focusToken: s.focusToken + 1 })),
  },
};
export async function executeConsole(command: string) {
  const [name, ...args] = command.trim().split(/\s+/);
  const state = useWorkspace.getState();
  if (!name) return;
  state.log(`› ${command}`);
  if (name === "help")
    state.log("help · clear · inspect <instanceId> · save · export · focus");
  else if (name === "clear") useWorkspace.setState({ logs: [] });
  else if (name === "inspect") {
    const instance = state.project?.instances.find(
      (i) => i.instanceId === args[0],
    );
    if (!instance) throw new Error("未找到此实例");
    state.select(instance.instanceId);
    state.log(JSON.stringify(instance, null, 2));
  } else if (Object.hasOwn(commandRegistry, name) && name !== "new")
    await commandRegistry[name as keyof typeof commandRegistry].run();
  else
    throw new Error("未知应用命令，输入 help 查看。此控制台不执行系统命令。");
}
export function reportError(error: unknown) {
  const message =
    error instanceof ZodError
      ? `文件结构校验失败：${error.issues
          .slice(0, 4)
          .map((i) => `${i.path.join(".") || "root"} — ${i.message}`)
          .join("；")}`
      : error instanceof Error
        ? error.message
        : String(error);
  useWorkspace.getState().log(message, "error");
}

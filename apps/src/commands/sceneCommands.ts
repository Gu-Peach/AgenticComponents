/** 清理当前放置内容，或在新场景资源就绪后一次性替换场景。 */
import type { AssetRecord, ProjectDocument } from "@/contracts/device";
import type { ScenePackageInstance } from "@/contracts/scene-package";
import { isActive } from "@/contracts/preview";
import { preview } from "@/runtime/services";
import { runtimeController } from "@/services/RuntimeController";
import { sceneRuntimeController } from "@/services/SceneRuntimeController";
import { useInteraction } from "@/stores/interaction";
import { useWorkspace } from "@/stores/workspace";

export function requireEditableScene(project: ProjectDocument) {
  const state = useWorkspace.getState();
  if (state.project !== project)
    throw new Error("项目已改变，请重新执行场景操作");
  if (
    state.documentLocked ||
    sceneRuntimeController.activeSessionId() ||
    runtimeController.isBusy() ||
    isActive(preview.getSnapshot().status)
  )
    throw new Error("请先停止并重置当前仿真，再清理或导入场景");
}

export async function replaceSceneContents(
  project: ProjectDocument,
  replacement?: { scene: ScenePackageInstance; asset: AssetRecord },
) {
  requireEditableScene(project);
  await preview.reset();
  requireEditableScene(project);
  runtimeController.reset();
  sceneRuntimeController.forgetInactiveScenes(
    project.scenePackages?.map((scene) => scene.id) ?? [],
  );
  useInteraction.setState({
    drag: null,
    candidate: null,
    suppressClickUntil: 0,
  });
  const next = replacement?.scene;
  useWorkspace.setState({
    project: {
      ...project,
      revision: project.revision + 1,
      instances: [],
      scenePackages: next ? [next] : [],
      connections: [],
      plc: "",
      assets:
        replacement &&
        !project.assets.some((asset) => asset.id === replacement.asset.id)
          ? [...project.assets, replacement.asset]
          : project.assets,
    },
    selectedId: next?.id ?? null,
    selectedSceneDeviceId: null,
    activeSceneId: next?.id ?? null,
    selectedInterface: null,
    inspectorTarget: "scene",
    modelNodes: {},
    modelErrors: {},
    dirty: true,
    dock: "plc",
    dockOpen: true,
    notice: "",
    focusToken: useWorkspace.getState().focusToken + 1,
  });
}

export async function clearScene() {
  const project = useWorkspace.getState().project;
  if (!project) return;
  await replaceSceneContents(project);
  useWorkspace.getState().log("场景已清理，可以重新添加设备或导入整场景");
}

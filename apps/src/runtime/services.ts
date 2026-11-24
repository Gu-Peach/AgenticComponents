/** 组装工作台共用的行为预览服务，将执行器、场景对象、设备观测和日志接入预览控制器，并同步文档锁定状态。 */

import { runtimeController } from "@/services/RuntimeController";
import { ExecutorRegistry } from "./ExecutorRegistry";
import { PreviewController } from "./PreviewController";
import { mockAdapter } from "./adapters/MockAdapter";
import { registerAgentAdapters } from "./adapters/agent/registerAgentAdapters";
import { previewSceneContext } from "@/renderer/SceneObjectRegistry";
import { useWorkspace } from "@/stores/workspace";
import { isActive } from "@/contracts/preview";
import { ObservationSource } from "./ObservationSource";
export const executors = new ExecutorRegistry();
executors.register(mockAdapter);
registerAgentAdapters(executors);
export const observations = new ObservationSource();
export const preview = new PreviewController(
  executors,
  {
    ...previewSceneContext,
    log: (message) => useWorkspace.getState().log(message),
  },
  (message) => useWorkspace.getState().log(message),
  observations.read,
);
let previewOwnsDocument = false;
preview.subscribe(() => {
  const active = isActive(preview.getSnapshot().status);
  if (active !== previewOwnsDocument) {
    previewOwnsDocument = active;
    useWorkspace.setState({
      documentLocked: active || runtimeController.isBusy(),
    });
  }
  if (preview.getSnapshot().status === "idle") observations.clear();
});

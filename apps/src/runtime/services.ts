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
preview.subscribe(() => {
  const documentLocked = isActive(preview.getSnapshot().status);
  if (useWorkspace.getState().documentLocked !== documentLocked) {
    useWorkspace.setState({ documentLocked });
  }
  if (preview.getSnapshot().status === "idle") observations.clear();
});

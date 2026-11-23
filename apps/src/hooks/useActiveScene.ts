import { useWorkspace } from "@/stores/workspace";

export function useActiveScene() {
  return useWorkspace((s) =>
    s.project?.scenePackages?.find((scene) => scene.id === s.activeSceneId),
  );
}

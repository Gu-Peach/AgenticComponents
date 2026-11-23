import { useEffect, useRef, useSyncExternalStore } from "react";
import { useFrame } from "@react-three/fiber";
import type { Object3D } from "three";
import { sceneRuntimeController as controller } from "@/services/SceneRuntimeController";
import { bindSceneVisuals } from "./bindSceneVisuals";

export function ScenePhysicsBridge({
  model,
  instanceId,
}: {
  model: Object3D;
  instanceId: string;
}) {
  const config = useSyncExternalStore(
    controller.subscribe,
    () => controller.configuration(instanceId),
    () => undefined,
  );
  const visuals = useRef<ReturnType<typeof bindSceneVisuals> | null>(null);
  useEffect(() => {
    if (!config) return;
    const binding = bindSceneVisuals(model, config);
    visuals.current = binding;
    const frame = controller.visualFrame(instanceId);
    if (frame) binding.apply(frame);
    return () => {
      visuals.current = null;
      binding.dispose();
    };
  }, [model, instanceId, config]);
  useFrame(() => {
    const binding = visuals.current;
    if (!binding) return;
    const frame = controller.visualFrame(instanceId);
    if (frame) binding.apply(frame);
  });
  return null;
}

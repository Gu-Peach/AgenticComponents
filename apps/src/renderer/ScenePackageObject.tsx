import { useEffect, useRef } from "react";
import { Group } from "three";
import type { ScenePackageInstance } from "@/contracts/scene-package";
import { ImportedModel } from "./ImportedModel";
import { raycastScenePackage } from "./sceneDeviceMaterials";
import { sceneObjects } from "./SceneObjectRegistry";
import { useWorkspace } from "@/stores/workspace";

export function ScenePackageObject({ scene }: { scene: ScenePackageInstance }) {
  const root = useRef<Group>(null!);
  const selected = useWorkspace((s) => s.selectedId === scene.id);
  useEffect(() => sceneObjects.register(scene.id, root.current), [scene.id]);
  return (
    <group
      ref={root}
      raycast={raycastScenePackage}
      onClick={(e) => {
        e.stopPropagation();
        useWorkspace.getState().select(scene.id);
      }}
    >
      <ImportedModel
        scenePackage={scene}
        assetId={scene.assetId}
        instanceId={scene.id}
        selected={selected}
      />
    </group>
  );
}

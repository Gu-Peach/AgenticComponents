import { useEffect } from "react";
import {
  Box3Helper,
  BoxHelper,
  Color,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  type Box3,
} from "three";
import { useThree, useFrame } from "@react-three/fiber";
import { useRef } from "react";
export function SelectionHighlight({
  model,
  selected,
  packageBounds,
}: {
  model: Object3D;
  selected: boolean;
  packageBounds?: Box3;
}) {
  const scene = useThree((s) => s.scene);
  const helper = useRef<BoxHelper | null>(null);
  useEffect(() => {
    if (!selected) return;
    const originals = new Map<
      MeshStandardMaterial,
      { color: Color; intensity: number }
    >();
    model.traverse((o) => {
      if (o instanceof Mesh)
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          if (m instanceof MeshStandardMaterial && !originals.has(m)) {
            originals.set(m, {
              color: m.emissive.clone(),
              intensity: m.emissiveIntensity,
            });
            m.emissive.set("#e68c39");
            m.emissiveIntensity = 0.22;
          }
    });
    const box = packageBounds
      ? new Box3Helper(packageBounds, 0xf39a4b)
      : new BoxHelper(model, 0xf39a4b);
    box.raycast = () => {};
    helper.current = box instanceof BoxHelper ? box : null;
    (packageBounds ? (model.parent ?? scene) : scene).add(box);
    return () => {
      originals.forEach((v, m) => {
        m.emissive.copy(v.color);
        m.emissiveIntensity = v.intensity;
      });
      box.removeFromParent();
      box.dispose();
      helper.current = null;
    };
  }, [model, selected, scene, packageBounds]);
  useFrame(() => helper.current?.update());
  return null;
}

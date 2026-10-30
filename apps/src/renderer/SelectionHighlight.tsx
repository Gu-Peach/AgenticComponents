import { useEffect } from "react";
import { BoxHelper, Color, Mesh, MeshStandardMaterial, Object3D } from "three";
import { useThree, useFrame } from "@react-three/fiber";
import { useRef } from "react";
export function SelectionHighlight({
  model,
  selected,
}: {
  model: Object3D;
  selected: boolean;
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
    const box = new BoxHelper(model, 0xf39a4b);
    box.raycast = () => {};
    helper.current = box;
    scene.add(box);
    return () => {
      originals.forEach((v, m) => {
        m.emissive.copy(v.color);
        m.emissiveIntensity = v.intensity;
      });
      scene.remove(box);
      box.geometry.dispose();
      box.material.dispose();
      helper.current = null;
    };
  }, [model, selected, scene]);
  useFrame(() => helper.current?.update());
  return null;
}

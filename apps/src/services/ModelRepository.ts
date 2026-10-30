import { Mesh, Object3D, Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { projectRepository } from "./BrowserProjectRepository";
const cache = new Map<string, { promise: Promise<Object3D>; refs: number }>();
function dispose(root: Object3D) {
  const textures = new Set<Texture>();
  root.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        Object.values(m).forEach((v) => {
          if (v instanceof Texture) textures.add(v);
        });
        m.dispose();
      }
    }
  });
  textures.forEach((t) => t.dispose());
}
export async function acquireModel(id: string) {
  let entry = cache.get(id);
  if (!entry) {
    const promise = (async () => {
      const blob = await projectRepository.getAsset(id);
      if (!blob) throw new Error("模型文件缺失，请重新关联 GLB");
      return (await new GLTFLoader().parseAsync(await blob.arrayBuffer(), ""))
        .scene;
    })();
    entry = { promise, refs: 0 };
    cache.set(id, entry);
  }
  const owned = entry;
  owned.refs++;
  let source: Object3D;
  try {
    source = await owned.promise;
  } catch (e) {
    owned.refs--;
    if (cache.get(id) === owned) cache.delete(id);
    throw e;
  }
  const root = clone(source);
  root.traverse((o) => {
    if (o instanceof Mesh) {
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => m.clone())
        : o.material.clone();
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  let released = false;
  return {
    root,
    release() {
      if (released) return;
      released = true;
      root.traverse((o) => {
        if (o instanceof Mesh)
          for (const m of Array.isArray(o.material) ? o.material : [o.material])
            m.dispose();
      });
      if (--owned.refs === 0) {
        if (cache.get(id) === owned) cache.delete(id);
        dispose(source);
      }
    },
  };
}

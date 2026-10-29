import type { Object3D } from "three";
import type { PreviewContext } from "@/contracts/preview";
const roots = new Map<string, Object3D>();
export const sceneObjects = {
  register(id: string, root: Object3D) {
    roots.set(id, root);
    return () => {
      if (roots.get(id) === root) roots.delete(id);
    };
  },
  node(id: string, name: string) {
    const root = roots.get(id);
    return name === "$root" ? root : root?.getObjectByName(name);
  },
};
export const previewSceneContext: Omit<PreviewContext, "log"> = {
  hasNode: (id, name) => Boolean(sceneObjects.node(id, name)),
  readNode(id, name) {
    const n = sceneObjects.node(id, name);
    return n
      ? { position: n.position.toArray(), quaternion: n.quaternion.toArray() }
      : null;
  },
  writeNode(id, name, pose) {
    const n = sceneObjects.node(id, name);
    if (!n) throw new Error(`节点不存在: ${name}`);
    n.position.fromArray(pose.position);
    n.quaternion.fromArray(pose.quaternion);
  },
};

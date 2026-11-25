import {
  Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type Group,
  type Raycaster,
  type Intersection,
} from "three";
/** 显示开关作用于模型实例独占的材质，运行时仍可独立控制刚体和成品替身的可见性。 */
export function sceneDeviceMaterials(
  model: Object3D,
  owners: ReadonlyMap<number, string>,
) {
  const groups = new Map<string, Set<Material>>();
  model.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    // GLTFLoader 对多 primitive 的节点把关联索引放在网格的上一级 Group。
    let node: Object3D | null = object;
    while (node && !Number.isInteger(node.userData.sceneNodeIndex))
      node = node.parent;
    const id = node && owners.get(node.userData.sceneNodeIndex);
    if (!id) return;
    let materials = groups.get(id);
    if (!materials) groups.set(id, (materials = new Set()));
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material])
      materials.add(material);
  });
  return groups;
}

export function applyDeviceVisibility(
  groups: ReadonlyMap<string, Set<Material>>,
  hiddenIds: readonly string[],
) {
  const changed: Material[] = [];
  for (const id of hiddenIds)
    for (const material of groups.get(id) ?? [])
      if (material.visible) {
        material.visible = false;
        changed.push(material);
      }
  return () => {
    for (const material of changed) material.visible = true;
  };
}

export function highlightDevice(materials: Set<Material> | undefined) {
  const restore: (() => void)[] = [];
  for (const material of materials ?? []) {
    if (!(material instanceof MeshStandardMaterial)) continue;
    const color = material.emissive.clone(),
      intensity = material.emissiveIntensity;
    material.emissive.set("#e68c39");
    material.emissiveIntensity = 0.22;
    restore.push(() => {
      material.emissive.copy(color);
      material.emissiveIntensity = intensity;
    });
  }
  return () => restore.forEach((reset) => reset());
}

/** Three 的 Raycaster 也返回不可见材质的交点。先筛去隐藏部件，使后方设备仍能收到点击。 */
export function raycastScenePackage(
  this: Group,
  raycaster: Raycaster,
  intersections: Intersection[],
) {
  for (const hit of raycaster.intersectObjects(this.children, true)) {
    const mesh = hit.object;
    if (mesh instanceof Mesh) {
      const material = Array.isArray(mesh.material)
        ? mesh.material[hit.face?.materialIndex ?? 0]
        : mesh.material;
      if (!material?.visible) continue;
    }
    let parent: Object3D | null = mesh;
    while (parent && parent.visible) parent = parent.parent;
    if (!parent) intersections.push(hit);
  }
  // Three skips the default recursive pass when this callback returns false.
  return false;
}

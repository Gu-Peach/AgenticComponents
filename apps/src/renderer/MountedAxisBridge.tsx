import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Matrix4, PropertyBinding, Vector3, type Object3D } from "three";
import { runtimeController } from "@/services/RuntimeController";
import { useWorkspace } from "@/stores/workspace";

/** 将物理世界中的位移向量转换为可动部件相对于父节点的位移；可重复调用且不积累漂移。 */
export function applyMountedNodeOffset(
  node: Object3D,
  rest: Vector3,
  offset?: [number, number, number],
) {
  node.position.copy(rest);
  if (node.parent && offset) {
    node.parent.updateWorldMatrix(true, false);
    const inverse = new Matrix4().copy(node.parent.matrixWorld).invert();
    node.position.add(
      new Vector3(...offset)
        .applyMatrix4(inverse)
        .sub(new Vector3().applyMatrix4(inverse)),
    );
  }
  node.updateMatrixWorld();
}

/** 平台节点在父物体局部坐标中移动，底座位移由实例根节点统一应用。 */
export function MountedAxisBridge({
  model,
  instanceId,
}: {
  model: Object3D;
  instanceId: string;
}) {
  const name = useWorkspace((s) => {
    const i = s.project?.instances.find((i) => i.instanceId === instanceId),
      d = s.project?.definitions.find((d) => d.specId === i?.specId);
    const sim = d?.typeSpecificContract.simulation as
      { platform_node?: string } | undefined;
    const carriage = d?.typeSpecificContract.moving_node;
    if (d?.deviceType === "linear_rail" && typeof carriage === "string")
      return carriage;
    return d?.deviceType === "lift_table" ? sim?.platform_node : undefined;
  });
  const bound = useMemo(() => {
    if (!name) return;
    let original: Object3D | undefined;
    model.traverse((object) => {
      if (object.userData.name === name) original = object;
    });
    const node =
      original ?? model.getObjectByName(PropertyBinding.sanitizeNodeName(name));
    if (node) return { node, rest: node.position.clone() };
  }, [model, name]);
  useEffect(
    () => () => {
      if (bound) bound.node.position.copy(bound.rest);
    },
    [bound],
  );
  useFrame(() => {
    if (!bound?.node.parent) return;
    const { node, rest } = bound;
    const anim = runtimeController.snapshot().mounted?.nodes[instanceId];
    applyMountedNodeOffset(
      node,
      rest,
      anim?.name === name ? anim?.offset : undefined,
    );
  });
  return null;
}

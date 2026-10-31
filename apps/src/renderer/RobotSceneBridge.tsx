import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Quaternion, Vector3, type Object3D } from "three";
import { useWorkspace } from "@/stores/workspace";
import { runtimeController } from "@/services/RuntimeController";
import { robotModelSchema } from "@/contracts/robot";
export function RobotSceneBridge({
  model,
  instanceId,
}: {
  model: Object3D;
  instanceId: string;
}) {
  const def = useWorkspace((s) => {
    const i = s.project?.instances.find((i) => i.instanceId === instanceId);
    return s.project?.definitions.find((d) => d.specId === i?.specId);
  });
  const bindings = useMemo(() => {
    if (
      def?.deviceType !== "robot_arm" ||
      def.source?.contract_version !== "1.4"
    )
      return [];
    return robotModelSchema
      .parse(def.typeSpecificContract)
      .urdf.joints.map((j) => {
        const n = model.getObjectByName(j.nodeName);
        if (!n) throw new Error(`关节节点缺失 ${j.nodeName}`);
        return {
          node: n,
          rest: n.quaternion.clone(),
          axis: new Vector3(...j.axis),
        };
      });
  }, [model, def]);
  useEffect(
    () => () => {
      bindings.forEach((b) => b.node.quaternion.copy(b.rest));
      model.updateMatrixWorld(true);
    },
    [bindings, model],
  );
  useFrame(() => {
    const s = runtimeController.snapshot(),
      active =
        s.instanceId === instanceId &&
        !!s.robot &&
        ["ready", "running", "paused"].includes(s.status);
    bindings.forEach((b, i) => {
      b.node.quaternion.copy(b.rest);
      if (active)
        b.node.quaternion.multiply(
          new Quaternion().setFromAxisAngle(b.axis, s.robot!.q[i]),
        );
    });
    if (bindings.length) model.updateMatrixWorld(true);
  });
  return null;
}

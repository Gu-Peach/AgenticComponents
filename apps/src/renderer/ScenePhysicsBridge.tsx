import { useEffect, useSyncExternalStore } from "react";
import { Group, Matrix4, Quaternion, Vector3, type Object3D } from "three";
import type { BodyPose } from "@/contracts/physics";
import { sceneRuntimeController as controller } from "@/services/SceneRuntimeController";

/** Applies one immutable scene snapshot; rendering never advances simulation time. */
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
  useEffect(() => {
    if (!config) return;
    model.updateMatrixWorld(true);
    const nodes = new Map<number, Object3D>();
    model.traverse((o) => {
      if (Number.isInteger(o.userData.sceneNodeIndex))
        nodes.set(o.userData.sceneNodeIndex, o);
    });
    const original = [...nodes.values()].map((node) => ({
      node,
      parent: node.parent,
      matrix: node.matrix.clone(),
      visible: node.visible,
    }));
    const modelInverse = model.matrixWorld.clone().invert();
    // Copy the source mesh transforms before separating the carrier from its payload.
    const templates = new Map(
      [...nodes].map(([i, n]) => [
        i,
        { node: n, sceneMatrix: modelInverse.clone().multiply(n.matrixWorld) },
      ]),
    );
    const groups = new Map<string, Group>();
    for (const binding of config.visualBodies) {
      const group = new Group();
      group.name = "runtime:" + binding.instanceId;
      model.add(group);
      groups.set(binding.bodyId, group);
      const inverse = new Matrix4()
        .compose(
          new Vector3(...binding.initial.position),
          new Quaternion(...binding.initial.rotation),
          new Vector3(1, 1, 1),
        )
        .invert();
      for (const index of binding.meshes) {
        const template = templates.get(index);
        if (!template) continue;
        const node = binding.future ? template.node.clone(true) : template.node;
        group.add(node);
        inverse
          .clone()
          .multiply(template.sceneMatrix)
          .decompose(node.position, node.quaternion, node.scale);
        node.updateMatrix();
      }
      group.position.fromArray(binding.initial.position);
      group.quaternion.fromArray(binding.initial.rotation);
      group.visible = !binding.future;
    }
    const joints = [...config.robots].map(([id, robot]) => ({
      id,
      joints: robot.model.urdf.joints.map((j, i) => {
        const index = config.robotNodes.get(id)?.[i];
        const node = index === undefined ? undefined : nodes.get(index);
        return node
          ? {
              node,
              rest: node.quaternion.clone(),
              axis: new Vector3(...j.axis),
            }
          : undefined;
      }),
    }));
    const update = () => {
      const snapshot = controller.snapshot(instanceId);
      if (!snapshot) return;
      const world = snapshot.observations.samples["world/state"];
      if (world?.quality === "good" && world.runId === snapshot.runId) {
        const state = world.value as {
          bodies: Record<string, { active: boolean; pose?: BodyPose }>;
        };
        for (const [id, group] of groups) {
          const body = state.bodies[id];
          group.visible = body?.active === true;
          if (body?.pose) {
            group.position.fromArray(body.pose.position);
            group.quaternion.fromArray(body.pose.rotation);
          }
        }
      }
      for (const robot of joints) {
        const sample = snapshot.observations.samples[robot.id + "/robot_state"];
        if (sample?.quality !== "good" || sample.runId !== snapshot.runId)
          continue;
        const q = (sample.value as { q: number[] }).q;
        robot.joints.forEach((joint, i) => {
          if (joint && Number.isFinite(q[i]))
            joint.node.quaternion
              .copy(joint.rest)
              .multiply(new Quaternion().setFromAxisAngle(joint.axis, q[i]));
        });
      }
      model.updateMatrixWorld(true);
    };
    update();
    const unsubscribe = controller.subscribe(update);
    return () => {
      unsubscribe();
      for (const saved of original) {
        if (saved.parent) saved.parent.add(saved.node);
        saved.matrix.decompose(
          saved.node.position,
          saved.node.quaternion,
          saved.node.scale,
        );
        saved.node.visible = saved.visible;
        saved.node.updateMatrix();
      }
      for (const group of groups.values()) group.removeFromParent();
      model.updateMatrixWorld(true);
    };
  }, [model, instanceId, config]);
  return null;
}

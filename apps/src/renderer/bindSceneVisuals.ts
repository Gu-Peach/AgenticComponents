import { Group, Matrix4, Quaternion, Vector3, type Object3D } from "three";
import type { BodyPose } from "@/contracts/physics";
import type {
  CompiledSceneRuntime,
  VisualBodyBinding,
} from "@/contracts/scene-execution";
import type { SceneVisualSnapshot } from "@/runtime/engine/SceneRuntimeProgram";
import { bindCarryArm } from "./bindCarryArm";

type VisualFrame = {
  previous: SceneVisualSnapshot;
  current: SceneVisualSnapshot;
  alpha: number;
};
type BodyState = {
  active: boolean;
  pose?: BodyPose;
  materialState?: "raw" | "finished";
};

function reading<T>(s: SceneVisualSnapshot, key: string): T | undefined {
  const sample = s.observations.samples[key];
  return sample?.quality === "good" && sample.runId === s.runId
    ? (sample.value as T)
    : undefined;
}

/** Binds immutable scene poses to Three objects for the lifetime of a prepared session. */
export function bindSceneVisuals(
  model: Object3D,
  config: Pick<
    CompiledSceneRuntime,
    | "visualBodies"
    | "robots"
    | "robotNodes"
    | "hiddenMeshes"
    | "indexedProcessing"
  >,
) {
  model.updateWorldMatrix(true, true);
  const nodes = new Map<number, Object3D>();
  model.traverse((node) => {
    if (Number.isInteger(node.userData.sceneNodeIndex))
      nodes.set(node.userData.sceneNodeIndex, node);
  });

  // Capture GLB rest transforms before the original meshes become children of the first body.
  const inverseModel = model.matrixWorld.clone().invert();
  const templates = new Map<number, { node: Object3D; sceneMatrix: Matrix4 }>();
  const visualNodes = (binding: VisualBodyBinding) =>
    binding.rootNodeIndex === undefined
      ? binding.meshes
      : [binding.rootNodeIndex];
  for (const binding of config.visualBodies) {
    for (const index of [
      ...visualNodes(binding),
      ...(binding.finishedVariant?.meshes ?? []),
    ]) {
      const node = nodes.get(index);
      if (node && !templates.has(index))
        templates.set(index, {
          node,
          sceneMatrix: inverseModel.clone().multiply(node.matrixWorld),
        });
    }
  }
  const originals: {
    node: Object3D;
    parent: Object3D | null;
    local: Matrix4;
  }[] = [];
  const groups = new Map<string, Group>();
  const variants = new Map<string, { raw: Group; finished: Group }>();
  const hidden = new Map<Object3D, boolean>();
  for (const index of config.hiddenMeshes ?? []) {
    const node = nodes.get(index);
    if (node && !hidden.has(node)) {
      hidden.set(node, node.visible);
      node.visible = false;
    }
  }
  const matrix = new Matrix4(),
    inverse = new Matrix4(),
    unit = new Vector3(1, 1, 1);
  const position = new Vector3(),
    endPosition = new Vector3(),
    rotation = new Quaternion(),
    endRotation = new Quaternion();
  function attach(binding: VisualBodyBinding) {
    const group = new Group();
    group.name = "runtime:" + binding.instanceId;
    group.matrixAutoUpdate = false;
    group.position.fromArray(binding.initial.position);
    group.quaternion.fromArray(binding.initial.rotation);
    group.updateMatrix();
    inverse.compose(group.position, group.quaternion, unit).invert();
    const raw = binding.finishedVariant ? new Group() : group;
    if (raw !== group) group.add(raw);
    for (const index of visualNodes(binding)) {
      const template = templates.get(index);
      if (!template) continue;
      const node = binding.future ? template.node.clone(true) : template.node;
      if (!binding.future)
        originals.push({
          node,
          parent: node.parent,
          local: node.matrix.clone(),
        });
      raw.add(node);
      matrix
        .multiplyMatrices(inverse, template.sceneMatrix)
        .decompose(node.position, node.quaternion, node.scale);
      node.updateMatrix();
    }
    if (binding.finishedVariant) {
      const finished = new Group();
      const { meshes, initial } = binding.finishedVariant;
      inverse
        .compose(
          position.fromArray(initial.position),
          rotation.fromArray(initial.rotation),
          unit,
        )
        .invert();
      for (const index of meshes) {
        const template = templates.get(index);
        if (!template)
          throw new Error("Missing finished material mesh " + index);
        const node = template.node.clone(true);
        node.visible = hidden.get(template.node) ?? template.node.visible;
        matrix
          .multiplyMatrices(inverse, template.sceneMatrix)
          .decompose(node.position, node.quaternion, node.scale);
        node.updateMatrix();
        finished.add(node);
      }
      finished.visible = false;
      group.add(finished);
      variants.set(binding.bodyId, { raw, finished });
    }
    model.add(group);
    groups.set(binding.bodyId, group);
    return group;
  }
  for (const binding of config.visualBodies)
    if (!binding.future) attach(binding);
  const character = config.indexedProcessing;
  const arm = character && bindCarryArm(model, nodes, character.humanArm);

  const robots = [...config.robots].map(([id, robot]) => ({
    key: id + "/robot_state",
    joints: robot.model.urdf.joints.map((joint, i) => {
      const index = config.robotNodes.get(id)?.[i],
        node = index === undefined ? undefined : nodes.get(index);
      return (
        node && {
          node,
          rest: node.quaternion.clone(),
          axis: new Vector3(...joint.axis),
          angle: 0,
        }
      );
    }),
  }));

  let lastSample: SceneVisualSnapshot | undefined,
    lastAlpha = -1;
  function apply({ previous, current, alpha }: VisualFrame) {
    const blend =
      previous.runId === current.runId &&
      current.tick === previous.tick + 1 &&
      (current.status === "running" || current.status === "stopping")
        ? Math.max(0, Math.min(1, alpha))
        : 1;
    if (lastSample === current && lastAlpha === blend) return;
    lastSample = current;
    lastAlpha = blend;
    const world = reading<{ bodies: Record<string, BodyState> }>(
      current,
      "world/state",
    );
    const previousWorld =
      blend < 1
        ? reading<{ bodies: Record<string, BodyState> }>(
            previous,
            "world/state",
          )
        : undefined;
    if (world) {
      for (const binding of config.visualBodies) {
        let group = groups.get(binding.bodyId);
        const body = world.bodies[binding.bodyId];
        if (!body?.active) {
          if (group?.visible) {
            group.visible = false;
            // The repository owns and disposes the original GLB materials. Keep
            // those nodes reachable even when their bodies are out of the world.
            if (binding.future) group.removeFromParent();
          }
          continue;
        }
        if (!body.pose) continue;
        group ??= attach(binding);
        const variant = variants.get(binding.bodyId);
        if (variant) {
          variant.finished.visible = body.materialState === "finished";
          variant.raw.visible = !variant.finished.visible;
        }
        if (!group.visible) {
          if (!group.parent) model.add(group);
          group.visible = true;
        }
        const old = previousWorld?.bodies[binding.bodyId];
        const pose = body.pose;
        endRotation.fromArray(pose.rotation);
        if (old?.active && old.pose) {
          position
            .fromArray(old.pose.position)
            .lerp(endPosition.fromArray(pose.position), blend);
          rotation.fromArray(old.pose.rotation).slerp(endRotation, blend);
        } else {
          position.fromArray(pose.position);
          rotation.copy(endRotation);
        }
        if (
          !group.position.equals(position) ||
          !group.quaternion.equals(rotation)
        ) {
          group.position.copy(position);
          group.quaternion.copy(rotation);
          group.updateMatrix();
        }
      }
    }
    if (arm && character) {
      const hand = world?.bodies[character.handBody]?.pose,
        prior = previousWorld?.bodies[character.handBody]?.pose;
      if (hand) {
        const target = endPosition.fromArray(hand.position);
        if (prior) target.lerp(position.fromArray(prior.position), 1 - blend);
        arm.apply(target);
      }
    }
    for (const robot of robots) {
      const currentQ = reading<{ q: number[] }>(current, robot.key)?.q;
      if (!currentQ) continue;
      const previousQ =
        blend < 1
          ? reading<{ q: number[] }>(previous, robot.key)?.q
          : undefined;
      for (let i = 0; i < robot.joints.length; i++) {
        const joint = robot.joints[i],
          q = currentQ[i];
        if (!joint || !Number.isFinite(q)) continue;
        const start = previousQ?.[i] ?? q;
        const angle = Number.isFinite(start) ? start + (q - start) * blend : q;
        if (joint.angle === angle) continue;
        joint.angle = angle;
        joint.node.quaternion
          .copy(joint.rest)
          .multiply(rotation.setFromAxisAngle(joint.axis, angle));
        if (!joint.node.matrixAutoUpdate) joint.node.updateMatrix();
      }
    }
  }
  function dispose() {
    arm?.reset();
    for (const [node, visibility] of hidden) node.visible = visibility;
    for (const { node, parent, local } of originals) {
      if (parent) parent.add(node);
      else node.removeFromParent();
      local.decompose(node.position, node.quaternion, node.scale);
      node.updateMatrix();
    }
    for (const robot of robots)
      for (const joint of robot.joints) {
        if (joint) {
          joint.node.quaternion.copy(joint.rest);
          joint.node.updateMatrix();
        }
      }
    for (const group of groups.values()) group.removeFromParent();
    model.updateWorldMatrix(true, true);
  }
  return { apply, dispose };
}

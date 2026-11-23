import { it, expect } from "vitest";
import { Matrix4, Object3D, Quaternion, Vector3 } from "three";
import { sceneFixture } from "./fixtures";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";
import { RobotKinematics } from "../../src/runtime/kinematics/RobotKinematics";
import { bindSceneVisuals } from "../../src/renderer/bindSceneVisuals";
import type { SceneVisualSnapshot } from "../../src/runtime/engine/SceneRuntimeProgram";

function sceneObjects(bytes: ArrayBuffer) {
  const data = new DataView(bytes),
    raw = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(bytes, 20, data.getUint32(12, true)),
      ),
    );
  type Node = {
    name?: string;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    children?: number[];
  };
  const nodes = (raw.nodes as Node[]).map((n, index) => {
    const o = new Object3D();
    o.name = n.name ?? "";
    o.userData.sceneNodeIndex = index;
    if (n.matrix)
      new Matrix4()
        .fromArray(n.matrix)
        .decompose(o.position, o.quaternion, o.scale);
    else {
      o.position.fromArray(n.translation ?? [0, 0, 0]);
      o.quaternion.fromArray(n.rotation ?? [0, 0, 0, 1]);
      o.scale.fromArray(n.scale ?? [1, 1, 1]);
    }
    return o;
  });
  (raw.nodes as Node[]).forEach((n, i) =>
    n.children?.forEach((child) => nodes[i].add(nodes[child])),
  );
  const root = new Object3D();
  nodes.filter((n) => !n.parent).forEach((n) => root.add(n));
  return { root, nodes };
}

it.each(["S01", "S02", "S04", "S06"] as const)(
  "matches %s GLB flange position and orientation with runtime FK after joint motion",
  (scene) => {
    const { bundle, bytes, goal } = sceneFixture(scene),
      compiled = compileSceneRuntime(bundle, bytes, goal, "validation");
    const { root, nodes } = sceneObjects(bytes);
    for (const [id, robot] of compiled.robots) {
      const q = [0.15, -0.1, 0.2, 0.15, -0.2, 0.1];
      compiled.robotNodes
        .get(id)!
        .forEach((index, i) =>
          nodes[index].quaternion.multiply(
            new Quaternion().setFromAxisAngle(
              new Vector3(...robot.model.urdf.joints[i].axis),
              q[i],
            ),
          ),
        );
      root.updateMatrixWorld(true);
      const name = robot.model.tooling.tcp_node_name!,
        index = bundle.nodes.find(
          (n) => n.name.replace(/\s/g, "_").replace(/[\[\]\.:/]/g, "") === name,
        )!.index;
      const actual = nodes[index].localToWorld(
          new Vector3(...robot.model.tooling.tcp_local_frame.position),
        ),
        expected = new RobotKinematics(robot).forward(q).tcp;
      expect(actual.distanceTo(new Vector3(...expected.position))).toBeLessThan(
        1e-5,
      );
      const actualRotation = nodes[index]
        .getWorldQuaternion(new Quaternion())
        .multiply(
          new Quaternion(
            ...robot.model.tooling.tcp_local_frame.rotation_quaternion,
          ),
        );
      expect(
        actualRotation
          .normalize()
          .angleTo(new Quaternion(...expected.rotation).normalize()),
      ).toBeLessThan(1e-5);
    }
  },
);

it("shows S06's finished GLB on the same moving body and restores the authored scene on dispose", () => {
  const { bundle, bytes, goal } = sceneFixture("S06");
  const config = compileSceneRuntime(bundle, bytes, goal, "validation");
  const binding = config.visualBodies.find((b) => b.instanceId === "M01_01")!;
  const { root, nodes } = sceneObjects(bytes);
  root.updateMatrixWorld(true);
  const templateMesh = nodes[binding.finishedVariant!.meshes[0]];
  const rawMesh = nodes[binding.meshes[0]];
  const originals = [rawMesh, templateMesh].map((node) => ({
    node,
    parent: node.parent,
    world: node.matrixWorld.clone(),
    visible: node.visible,
  }));
  const visual = bindSceneVisuals(root, config);
  const group = root.getObjectByName("runtime:" + binding.instanceId)!;
  const worldPose = { ...binding.initial, position: [-3.16, 0.89, 3.76] };
  function frame(
    tick: number,
    materialState: "raw" | "finished",
  ): SceneVisualSnapshot {
    const runId = "S06-render";
    const key = "world/state";
    return {
      runId,
      tick,
      status: "running",
      observations: {
        runId,
        tick,
        samples: {
          [key]: {
            key,
            runId,
            sampledTick: tick,
            provider: "test",
            quality: "good",
            value: {
              bodies: {
                [binding.bodyId]: {
                  active: true,
                  pose: worldPose,
                  materialState,
                },
              },
            },
          },
        },
      },
    };
  }
  const before = frame(1, "raw");
  visual.apply({ previous: before, current: before, alpha: 1 });
  const visible = () => {
    const names: string[] = [];
    group.traverseVisible((node) => names.push(node.name));
    return names;
  };
  expect(visible()).toContain(rawMesh.name);
  expect(visible()).not.toContain(templateMesh.name);
  const rawPose = group.matrix.clone();
  visual.apply({ previous: before, current: frame(2, "finished"), alpha: 1 });
  expect(root.getObjectByName("runtime:" + binding.instanceId)).toBe(group);
  expect(group.position.toArray()).toEqual(worldPose.position);
  expect(group.matrix.equals(rawPose)).toBe(true);
  expect(visible()).toContain(templateMesh.name);
  expect(visible()).not.toContain(rawMesh.name);
  expect(templateMesh.visible).toBe(false);
  visual.dispose();
  expect(group.parent).toBeNull();
  for (const original of originals) {
    expect(original.node.visible).toBe(original.visible);
    expect(original.node.parent).toBe(original.parent);
    original.world.elements.forEach((v, i) =>
      expect(original.node.matrixWorld.elements[i]).toBeCloseTo(v, 10),
    );
  }
});

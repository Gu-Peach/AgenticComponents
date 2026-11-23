import { it, expect } from "vitest";
import { Matrix4, Object3D, Quaternion, Vector3 } from "three";
import { sceneFixture } from "./fixtures";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";
import { RobotKinematics } from "../../src/runtime/kinematics/RobotKinematics";
it.each(["S01", "S02"] as const)(
  "matches %s GLB flange position and orientation with runtime FK after joint motion",
  (scene) => {
    const { bundle, bytes, goal } = sceneFixture(scene),
      compiled = compileSceneRuntime(bundle, bytes, goal, "validation");
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
    const nodes = (raw.nodes as Node[]).map((n) => {
      const o = new Object3D();
      o.name = n.name ?? "";
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

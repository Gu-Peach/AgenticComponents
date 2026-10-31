import { Matrix4, Quaternion, Vector3 } from "three";
import type { CompiledRobotScene } from "@/contracts/robot";
import { RobotKinematics } from "@/runtime/kinematics/RobotKinematics";
interface Node {
  name?: string;
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  children?: number[];
}
export function validateRobotAsset(
  scene: CompiledRobotScene,
  bytes: ArrayBuffer,
) {
  const v = new DataView(bytes);
  if (v.getUint32(0, true) !== 0x46546c67) throw new Error("不是GLB资产");
  const g = JSON.parse(
    new TextDecoder().decode(new Uint8Array(bytes, 20, v.getUint32(12, true))),
  ) as { nodes: Node[]; scenes: { nodes: number[] }[]; scene?: number };
  const named = new Map<string, { world: Matrix4; local: Matrix4 }>();
  const visit = (id: number, parent: Matrix4) => {
    const n = g.nodes[id],
      local = n.matrix
        ? new Matrix4().fromArray(n.matrix)
        : new Matrix4().compose(
            new Vector3(...(n.translation ?? [0, 0, 0])),
            new Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
            new Vector3(...(n.scale ?? [1, 1, 1])),
          ),
      world = parent.clone().multiply(local);
    if (n.name) {
      if (named.has(n.name)) throw new Error("机器人源节点重名");
      named.set(n.name, { world, local });
    }
    for (const c of n.children ?? []) visit(c, world);
  };
  for (const id of g.scenes[g.scene ?? 0].nodes) visit(id, new Matrix4());
  for (const j of scene.model.urdf.joints) {
    const n = named.get(j.nodeName);
    if (!n) throw new Error(`缺少关节节点 ${j.nodeName}`);
    const q = new Quaternion();
    n.local.decompose(new Vector3(), q, new Vector3());
    q.normalize();
    if (q.angleTo(new Quaternion(...j.render_rest_quaternion)) > 1e-5)
      throw new Error("关节静止旋转与资产不符");
  }
  const tcp = named.get(scene.model.tooling.tcp_node_name);
  if (!tcp) throw new Error("TCP参考节点不存在");
  const t = scene.model.tooling.tcp_local_frame,
    tp = new Vector3(),
    tq = new Quaternion();
  tcp.world.decompose(tp, tq, new Vector3());
  tq.normalize();
  const expected = new Matrix4()
    .compose(tp, tq, new Vector3(1, 1, 1))
    .multiply(
      new Matrix4().compose(
        new Vector3(...t.position),
        new Quaternion(...t.rotation_quaternion),
        new Vector3(1, 1, 1),
      ),
    );
  // Source root includes 0.01 scaling. Verify the configured metric zero pose independently.
  const localScene = {
    ...scene,
    base: {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
    },
  };
  const zero = new RobotKinematics(localScene).forward([0, 0, 0, 0, 0, 0]);
  scene.model.urdf.joints.forEach((j, i) => {
    const n = named.get(j.nodeName)!;
    if (
      new Vector3()
        .setFromMatrixPosition(n.world)
        .distanceTo(zero.joints[i].pivot) > 1e-5
    )
      throw new Error("关节轴心与源资产不一致");
  });
  const actual = zero.tcp,
    p = new Vector3(),
    q = new Quaternion();
  expected.decompose(p, q, new Vector3());
  q.normalize();
  if (
    p.distanceTo(new Vector3(...actual.position)) > 1e-5 ||
    q.angleTo(new Quaternion(...actual.rotation)) > 1e-5
  )
    throw new Error("米制FK零点与GLB不符");
}

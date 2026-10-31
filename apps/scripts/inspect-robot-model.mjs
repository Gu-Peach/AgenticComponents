import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Matrix4, Vector3, Quaternion } from "three";
const path = process.argv[2] ?? "public/modles/robot_UR10/robot_UR10.glb";
const b = await readFile(path),
  g = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
const world = [],
  parents = [];
function visit(i, parent = new Matrix4()) {
  const n = g.nodes[i],
    m = n.matrix
      ? new Matrix4().fromArray(n.matrix)
      : new Matrix4().compose(
          new Vector3(...(n.translation ?? [0, 0, 0])),
          new Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
          new Vector3(...(n.scale ?? [1, 1, 1])),
        );
  world[i] = parent.clone().multiply(m);
  for (const c of n.children ?? []) {
    parents[c] = i;
    visit(c, world[i]);
  }
}
for (const i of g.scenes[g.scene ?? 0].nodes) visit(i);
const ids = [14, 18, 26, 33, 37, 41],
  axes = [
    [0, 1, 0],
    [0, 0, 1],
    [0, 0, 1],
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0],
  ];
const metric = world.map((m) => {
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  if (Math.max(...s.toArray()) - Math.min(...s.toArray()) > 1e-5)
    throw Error("nonuniform scale");
  return new Matrix4().compose(p, q, new Vector3(1, 1, 1));
});
function pose(m) {
  const p = new Vector3(),
    q = new Quaternion();
  m.decompose(p, q, new Vector3());
  return { position: p.toArray(), quaternion: q.normalize().toArray() };
}
const joints = ids.map((id, k) => {
  const n = g.nodes[id],
    rest = pose(
      k ? metric[ids[k - 1]].clone().invert().multiply(metric[id]) : metric[id],
    );
  return {
    name: `joint_${k + 1}`,
    nodeName: n.name,
    parent_joint: k ? `joint_${k}` : null,
    type: "revolute",
    axis: axes[k],
    axis_frame: "joint_local",
    rest_position: rest.position,
    rest_quaternion: rest.quaternion,
    render_rest_quaternion: pose(new Matrix4().fromArray(n.matrix)).quaternion,
    limit: { lower: -Math.PI, upper: Math.PI },
    velocity_limit_param: "joint_speed_rad_s",
    acceleration_limit_param: "joint_accel_rad_s2",
  };
});
console.log(
  JSON.stringify(
    {
      asset_sha256: createHash("sha256").update(b).digest("hex"),
      bytes: b.length,
      nodes: g.nodes.length,
      meshes: g.meshes.length,
      rootNodeName: g.nodes[0].name,
      joints,
      toolRest: pose(metric[41].clone().invert().multiply(metric[45])),
      source:
        "GLB matrices; axes are explicit simulation hinge choices, joint ranges are simulation limits, not manufacturer data",
    },
    null,
    2,
  ),
);

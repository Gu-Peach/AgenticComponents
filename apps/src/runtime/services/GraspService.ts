import { Matrix4, Quaternion, Vector3 } from "three";
import type { CompiledRobotScene } from "@/contracts/robot";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
const matrix = (p: BodyPose) =>
  new Matrix4().compose(
    new Vector3(...p.position),
    new Quaternion(...p.rotation),
    new Vector3(1, 1, 1),
  );
export class GraspService {
  private binding?: Matrix4;
  private constraintId: string;
  constructor(
    private scene: CompiledRobotScene,
    private physics: PhysicsPort,
  ) {
    this.constraintId = `${scene.instanceId}/grasp`;
  }
  get holding() {
    return !!this.binding && !!this.physics.hasGrasp?.(this.constraintId);
  }
  get relative() {
    return this.binding?.clone();
  }
  grip(tcp: BodyPose, materialId: string) {
    const s = this.scene,
      g = s.model.gripper;
    if (
      materialId !== s.materialInstanceId ||
      !s.materialBodyId ||
      !s.materialMass ||
      s.materialMass > s.maxPayload
    )
      throw new Error("抓取身份或载荷不合法");
    if (this.holding) throw new Error("夹具已经持有物料");
    const p = this.physics.readMaterial(),
      capture = new Vector3(0, s.materialSize![1] / 2 + 0.025, 0)
        .applyQuaternion(new Quaternion(...p.rotation))
        .add(new Vector3(...p.position));
    if (capture.distanceTo(new Vector3(...tcp.position)) > g.capture_radius_m)
      throw new Error("物料不在捕获区域");
    if (
      new Vector3(...p.velocity).sub(new Vector3(...tcp.velocity)).length() >
      g.max_relative_speed_mps
    )
      throw new Error("抓取相对速度过高");
    if (!this.physics.createGrasp) throw new Error("物理固定约束未实现");
    this.physics.createGrasp(this.constraintId, s.toolBodyId, s.materialBodyId);
    this.binding = matrix(tcp).invert().multiply(matrix(p));
  }
  error(tcp: BodyPose) {
    if (!this.binding) return 0;
    const expected = matrix(tcp).multiply(this.binding),
      p = this.physics.readMaterial();
    const pos = new Vector3(),
      q = new Quaternion();
    expected.decompose(pos, q, new Vector3());
    return Math.max(
      pos.distanceTo(new Vector3(...p.position)),
      q.angleTo(new Quaternion(...p.rotation)) * 0.1,
    );
  }
  release(materialId: string) {
    if (materialId !== this.scene.materialInstanceId || !this.holding)
      throw new Error("未持有指定物料");
    this.physics.removeGrasp?.(this.constraintId);
    this.binding = undefined;
  }
  placed() {
    const s = this.scene;
    if (!s.placementCenter) return false;
    const p = this.physics.readMaterial(),
      q = new Quaternion(...p.rotation),
      support = s.physics!.bodies!.find((b) => b.role === "conveying_support")!;
    const local = new Vector3(...p.position)
      .sub(new Vector3(...support.position))
      .applyQuaternion(new Quaternion(...support.rotation).invert());
    const relative = new Quaternion(...support.rotation).invert().multiply(q),
      half = new Vector3(...s.materialSize!).multiplyScalar(0.5);
    const corners: Vector3[] = [];
    for (const x of [-1, 1])
      for (const y of [-1, 1])
        for (const z of [-1, 1])
          corners.push(
            new Vector3(x * half.x, y * half.y, z * half.z).applyQuaternion(
              relative,
            ),
          );
    const extent = (axis: "x" | "z") =>
      Math.max(...corners.map((v) => Math.abs(v[axis])));
    return (
      this.physics.hasSupport(s.materialBodyId, s.supportSurfaceId) &&
      Math.abs(local.x) + extent("x") <= support.size[0] / 2 + 0.005 &&
      Math.abs(local.z) + extent("z") <= support.size[2] / 2 + 0.005 &&
      new Vector3(...p.position).distanceTo(new Vector3(...s.placementCenter)) <
        0.12 &&
      Math.hypot(...p.velocity) < 0.08 &&
      Math.hypot(...(p.angularVelocity ?? [0, 0, 0])) < 0.2
    );
  }
  dispose() {
    this.physics.removeGrasp?.(this.constraintId);
    this.binding = undefined;
  }
}

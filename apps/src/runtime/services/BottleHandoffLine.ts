/** 按瓶头和瓶尾的抓取接口规划双臂交接，核对瓶体与夹具的位姿后转移抓持约束，并验证倒置放料的位置与朝向。 */

import { Quaternion, Vector3 } from "three";
import type { ActionRequest } from "@/contracts/scheduler";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import type { WarehouseJob } from "@/runtime/adapters/scene/WarehouseActionAdapter";
import { HandoffArm, poseMatrix } from "./HandoffMotion";
import { restJointTarget } from "@/runtime/kinematics/restJointTarget";

const clearance = 0.017;
const range = 0.01;
const settled = (p: BodyPose) =>
  Math.hypot(...p.velocity) < 0.02 &&
  Math.hypot(...(p.angularVelocity ?? [])) < 0.12;
type MotionStage = {
  enter: () => void;
  ready: () => boolean;
  leave?: (tick: number) => void;
};

export class BottleHandoffLine {
  readonly arms: Map<string, HandoffArm>;
  readonly transfers: {
    material: string;
    from: string;
    to: string;
    tick: number;
  }[] = [];
  readonly placed = new Set<string>();
  private readonly config;
  constructor(
    private c: CompiledSceneRuntime,
    private physics: PhysicsPort,
  ) {
    this.config = c.handoff!;
    this.arms = new Map(
      [...c.robots].map(([id, model]) => [
        id,
        new HandoffArm(model, this.config.approachAxes.get(id)!, physics),
      ]),
    );
  }
  arm(id: string) {
    return this.arms.get(id)!;
  }
  body(id: string) {
    return this.c.bodyMap.get(id + "/body")!;
  }
  materialPose(id: string) {
    return this.physics.readBody!(this.body(id).id);
  }
  private point(id: string, frame: string, pose: BodyPose) {
    const f = this.config.materialFrames.get(id)!.points[frame];
    if (!f) throw new Error("未知物料抓取坐标系 " + frame);
    const q = new Quaternion(...pose.rotation),
      outward = new Vector3(...f.outward).applyQuaternion(q);
    const contact = new Vector3(...f.offset)
      .applyQuaternion(q)
      .add(new Vector3(...pose.position));
    return {
      contact,
      outward,
      tcp: contact.clone().addScaledVector(outward, clearance),
    };
  }
  onBelt(id: string, device: string) {
    const body = this.body(id);
    if (
      !body ||
      !this.physics.isBodyActive!(body.id) ||
      this.physics.hasGraspForBody!(body.id)
    )
      return false;
    const head = new Vector3(
      ...this.config.materialFrames.get(id)!.points.head.outward,
    ).applyQuaternion(new Quaternion(...this.materialPose(id).rotation));
    const alignment =
      device === this.config.outfeed
        ? head.dot(new Vector3(...this.config.outfeedAxis))
        : head.y;
    return (
      this.physics.hasContactSupport!(body.id, device + "/surface") &&
      alignment > Math.cos(this.config.maxTiltRad)
    );
  }
  checkPose(id: string, device: string, key: string) {
    if (!this.onBelt(id, device)) return false;
    const pose = this.materialPose(id),
      frame = device === this.config.outfeed ? "head" : "tail";
    return (
      settled(pose) &&
      this.point(id, frame, pose).contact.distanceTo(
        new Vector3(...this.c.devices.get(device)!.locations[key].position),
      ) < 0.025
    );
  }
  private targetPose(
    id: string,
    owner: string,
    key: string,
    frame?: string,
  ): BodyPose {
    const loc = this.c.devices.get(owner)?.locations[key],
      desired = loc?.material_pose;
    if (!loc || !desired) throw new Error("缺少物料目标姿态 " + key);
    const frames = this.config.materialFrames.get(id)!;
    const rotation = new Quaternion(...desired.orientation_quaternion).multiply(
      new Quaternion(...frames.rest).invert(),
    );
    const offset = frame
      ? frames.points[frame].offset
      : frames.points.head.offset.map(
          (v, i) => (v + frames.points.tail.offset[i]) / 2,
        );
    const center = new Vector3(...loc.position).sub(
      new Vector3(...offset).applyQuaternion(rotation),
    );
    return {
      position: center.toArray(),
      rotation: rotation.toArray(),
      velocity: [0, 0, 0],
    };
  }
  private graspPlan(
    arm: HandoffArm,
    id: string,
    frame: string,
    pose: BodyPose,
    approach: number,
  ) {
    const p = this.point(id, frame, pose),
      near = p.tcp.clone().addScaledVector(p.outward, approach);
    for (const roll of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const rotation = arm.rotationFacing(p.outward.clone().negate(), roll);
      const before = arm.solve(near, rotation);
      const at = before && arm.solve(p.tcp, rotation, before);
      if (before && at) return [before, at];
    }
    throw new Error(
      arm.scene.instanceId + " 未找到与 " + frame + " 对齐的抓取姿态",
    );
  }
  private aligned(arm: HandoffArm, id: string, frame: string) {
    const pose = this.materialPose(id),
      tool = arm.pose,
      point = this.point(id, frame, pose);
    return (
      point.tcp.distanceTo(new Vector3(...tool.position)) <= range &&
      arm.axis
        .clone()
        .applyQuaternion(new Quaternion(...tool.rotation))
        .dot(point.outward) < -0.985 &&
      new Vector3(...pose.velocity)
        .sub(new Vector3(...tool.velocity))
        .length() <= arm.scene.model.gripper.max_relative_speed_mps
    );
  }
  private carriedPath(
    arm: HandoffArm,
    id: string,
    targets: BodyPose[],
    label: string,
  ) {
    let seed = arm.q;
    const inverse = arm.relative!.clone().invert(),
      segments: number[][] = [];
    let from = this.materialPose(id);
    for (const target of targets) {
      const a = new Vector3(...from.position),
        b = new Vector3(...target.position);
      const start = new Quaternion(...from.rotation),
        end = new Quaternion(...target.rotation);
      const count = Math.max(
        1,
        Math.ceil(a.distanceTo(b) / 0.075),
        Math.ceil(start.angleTo(end) / 0.3),
      );
      for (let i = 1; i <= count; i++) {
        const pose = poseMatrix({
          position: a
            .clone()
            .lerp(b, i / count)
            .toArray(),
          rotation: start
            .clone()
            .slerp(end, i / count)
            .toArray(),
        });
        const tcp = pose.multiply(inverse),
          position = new Vector3(),
          rotation = new Quaternion();
        tcp.decompose(position, rotation, new Vector3());
        seed = arm.target(position, rotation, label, seed);
        segments.push(seed);
      }
      from = target;
    }
    return segments;
  }
  private raised(p: BodyPose, h: number): BodyPose {
    return {
      ...p,
      position: [p.position[0], p.position[1] + h, p.position[2]],
    };
  }
  private retained(arm: HandoffArm, id: string) {
    if (arm.held !== id || !arm.holding)
      throw new Error("在途物料丢失持有关系");
    const expected = poseMatrix(arm.pose).multiply(arm.relative!),
      actual = this.materialPose(id);
    const distance = new Vector3()
      .setFromMatrixPosition(expected)
      .distanceTo(new Vector3(...actual.position));
    const angle = new Quaternion()
      .setFromRotationMatrix(expected)
      .angleTo(new Quaternion(...actual.rotation));
    if (
      Math.max(distance, angle * 0.1) >
      arm.scene.model.gripper.constraint_tolerance_m
    )
      throw new Error("瓶体偏离夹具约束");
  }
  prepare(request: ActionRequest): WarehouseJob {
    const arm = this.arm(request.device);
    const f = (request.payload as { fields: Record<string, string> }).fields;
    if (request.behavior === "move_to_pose") {
      const loc = this.c.devices.get(request.device)!.locations[f.target];
      const home = restJointTarget(arm.scene, {
        position: loc.position,
        rotation: loc.rotation_quaternion!,
      });
      return this.job(
        [arm],
        [{ enter: () => arm.start([home]), ready: () => arm.atHome }],
      );
    }
    const id = f.material,
      body = this.body(id);
    if (body.mass! > arm.scene.maxPayload) throw new Error("瓶体超出夹具载荷");
    if (request.behavior === "pick_and_handoff") {
      const receiver = this.arm(f.receiver),
        start = this.materialPose(id);
      if (
        receiver.holding ||
        arm.holding ||
        body.mass! > receiver.scene.maxPayload ||
        !this.checkPose(id, this.config.infeed, f.source)
      )
        throw new Error("抓取位、夹具或物料载荷不满足要求");
      const pick = this.graspPlan(arm, id, f.giver_grasp, start, 0.09);
      const handoff = this.targetPose(id, arm.scene.instanceId, f.target);
      return this.job(
        [arm, receiver],
        [
          {
            enter: () => arm.start(pick),
            ready: () => arm.stopped,
            leave: () => {
              if (
                !this.aligned(arm, id, f.giver_grasp) ||
                !this.onBelt(id, this.config.infeed)
              )
                throw new Error("瓶头夹具未对准");
              this.physics.createGrasp!(
                arm.graspId,
                arm.scene.toolBodyId,
                body.id,
              );
              arm.attach(id, this.materialPose(id));
            },
          },
          {
            enter: () =>
              arm.start(
                this.carriedPath(
                  arm,
                  id,
                  [this.raised(this.materialPose(id), 0.22), handoff],
                  "搬运到交接位",
                ),
              ),
            ready: () => arm.stopped && settled(this.materialPose(id)),
          },
          {
            enter: () =>
              receiver.start(
                this.graspPlan(
                  receiver,
                  id,
                  f.receiver_grasp,
                  this.materialPose(id),
                  0.09,
                ),
              ),
            ready: () => receiver.stopped,
            leave: () => {
              this.retained(arm, id);
              const pose = this.materialPose(id);
              if (
                !settled(pose) ||
                !this.aligned(receiver, id, f.receiver_grasp)
              )
                throw new Error("接方瓶底夹具未对准");
              if (
                new Vector3(...pose.position).distanceTo(
                  new Vector3(...handoff.position),
                ) > 0.018 ||
                new Quaternion(...pose.rotation).angleTo(
                  new Quaternion(...handoff.rotation),
                ) > 0.08
              )
                throw new Error("瓶体未到达交接位姿");
              this.physics.transferGrasp!(
                arm.graspId,
                receiver.graspId,
                receiver.scene.toolBodyId,
                body.id,
              );
              receiver.attach(id, pose);
              arm.clear();
            },
          },
          {
            enter: () => {
              const pose = arm.pose;
              const away = this.point(
                id,
                f.giver_grasp,
                this.materialPose(id),
              ).outward.multiplyScalar(0.09);
              const p = new Vector3(...pose.position).add(away);
              arm.start([
                arm.target(p, new Quaternion(...pose.rotation), "离开交接位"),
              ]);
            },
            ready: () => arm.stopped,
            leave: (tick) =>
              this.transfers.push({
                material: id,
                from: arm.scene.instanceId,
                to: receiver.scene.instanceId,
                tick,
              }),
          },
        ],
      );
    }
    if (arm.held !== id || !arm.holding)
      throw new Error("接方没有持有指定瓶体");
    const land = this.targetPose(id, this.config.outfeed, f.target, "head");
    const release = this.raised(land, 0.001);
    const current = this.materialPose(id);
    const above = this.raised(land, 0.17);
    const path = this.carriedPath(
      arm,
      id,
      [this.raised(current, 0.12), above, release],
      "倒置放料",
    );
    let stable = 0;
    return this.job(
      [arm],
      [
        {
          enter: () => arm.start(path),
          ready: () => arm.stopped && settled(this.materialPose(id)),
          leave: () => {
            const pose = this.materialPose(id);
            if (
              new Vector3(...pose.position).distanceTo(
                new Vector3(...release.position),
              ) > 0.01 ||
              new Quaternion(...pose.rotation).angleTo(
                new Quaternion(...release.rotation),
              ) >
                Math.PI / 90
            )
              throw new Error("瓶体未达到倒置释放位姿");
            this.physics.removeGrasp!(arm.graspId);
            arm.clear();
          },
        },
        {
          enter: () => {},
          ready: () => {
            stable = this.checkPose(id, this.config.outfeed, f.target)
              ? stable + 1
              : 0;
            return stable >= 8;
          },
          leave: () => {
            this.placed.add(id);
          },
        },
        {
          enter: () => {
            const pose = arm.pose;
            arm.start([
              arm.target(
                new Vector3(...pose.position).add(new Vector3(0, 0.09, 0)),
                new Quaternion(...pose.rotation),
                "释放后抬升",
              ),
            ]);
          },
          ready: () => arm.stopped,
        },
      ],
    );
  }
  private job(arms: HandoffArm[], stages: MotionStage[]): WarehouseJob {
    let index = 0,
      elapsed = 0;
    return {
      begin: () => stages[0].enter(),
      before: () => {},
      after: (tick) => {
        for (const arm of arms) if (arm.held) this.retained(arm, arm.held);
        const stage = stages[index];
        if (++elapsed > 1800) throw new Error("机械臂或瓶体支承未在时限内稳定");
        if (stage.ready()) {
          stage.leave?.(tick);
          elapsed = 0;
          stages[++index]?.enter();
        }
      },
      cancel: () => arms.forEach((a) => a.stop()),
      complete: () => index === stages.length,
      stopped: () => arms.every((a) => a.stopped),
    };
  }
}

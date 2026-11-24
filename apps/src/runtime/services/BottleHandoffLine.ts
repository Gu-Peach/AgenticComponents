/** 按瓶头和瓶尾的抓取接口规划双臂交接，核对瓶体与夹具的位姿后转移抓持约束，并验证倒置放料的位置与朝向。 */

import { handoffBehavior } from "@/contracts/robot-handoff";
import { Quaternion, Vector3 } from "three";
import type { ActionRequest } from "@/contracts/scheduler";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import type { HandoffArm, PickPlaceMotion } from "@/devices/robot_arm/behavior";
import { getDeviceModule } from "@/devices/registry";

const clearance = 0.017;
const settled = (p: BodyPose) =>
  Math.hypot(...p.velocity) < 0.02 &&
  Math.hypot(...(p.angularVelocity ?? [])) < 0.12;
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
  private readonly motion: PickPlaceMotion;
  constructor(
    private c: CompiledSceneRuntime,
    private physics: PhysicsPort,
  ) {
    this.config = c.handoff!;
    const robotModule = getDeviceModule("robot_arm");
    this.motion = robotModule.createPickPlaceMotion(
      physics,
      (id) => this.body(id),
      (id, frame, pose) => this.point(id, frame, pose),
    );
    this.arms = new Map(
      [...c.robots].map(([id, model]) => [
        id,
        robotModule.createArticulatedArm(
          model,
          this.config.approachAxes.get(id)!,
          physics,
        ),
      ]),
    );
  }
  arm(id: string) {
    const arm = this.arms.get(id);
    if (!arm) throw new Error("Unknown handoff robot: " + id);
    return arm;
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
  atEndpoint(id: string, device: string, key: string) {
    if (!this.onBelt(id, device)) return false;
    const pose = this.materialPose(id);
    const frame = device === this.config.outfeed ? "head" : "tail";
    return (
      this.point(id, frame, pose).contact.distanceTo(
        new Vector3(...this.c.devices.get(device)!.locations[key].position),
      ) < 0.025
    );
  }

  checkPose(id: string, device: string, key: string) {
    return this.atEndpoint(id, device, key) && settled(this.materialPose(id));
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

  prepare(request: ActionRequest) {
    const arm = this.arm(request.device);
    const payload = request.payload as {
      binding?: string;
      fields: Record<string, string>;
    };
    const f = payload.fields,
      behavior = handoffBehavior(
        request.device,
        request.behavior,
        payload.binding,
      );
    if (behavior === "move_to_pose")
      return this.motion.home(
        arm,
        this.c.devices.get(request.device)!.locations[f.target],
      );
    if (behavior === "pick_and_handoff") {
      const receiver = this.arm(f.receiver);
      return this.motion.prepare(
        arm,
        f.material,
        {
          kind: "pick",
          frame: f.giver_grasp,
          sourceReady: () =>
            this.checkPose(f.material, this.config.infeed, f.source),
        },
        {
          kind: "gripper",
          receiver,
          frame: f.receiver_grasp,
          pose: this.targetPose(f.material, arm.scene.instanceId, f.target),
          commit: (tick) =>
            this.transfers.push({
              material: f.material,
              from: request.device,
              to: f.receiver,
              tick,
            }),
        },
      );
    }
    if (behavior !== "place_held_material")
      throw new Error("Unsupported transfer behavior: " + request.behavior);
    return this.motion.prepare(
      arm,
      f.material,
      { kind: "held", frame: f.grasp },
      {
        kind: "support",
        pose: this.targetPose(
          f.material,
          this.config.outfeed,
          f.target,
          "head",
        ),
        placed: () => this.checkPose(f.material, this.config.outfeed, f.target),
        commit: () => this.placed.add(f.material),
      },
    );
  }
}

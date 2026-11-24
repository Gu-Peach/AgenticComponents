/** 按设备声明的支承接口和姿态检查物料，并从实际刚体坐标系计算抓取、交接与放置目标。 */
import { Quaternion, Vector3 } from "three";
import type { BodyPose, PhysicsPort, RuntimeBody } from "@/contracts/physics";
import type { SceneDevice } from "@/contracts/scene-execution";
import type {
  MaterialGraspFrames,
  TransportPosePolicy,
} from "@/contracts/material-frames";
import { selectGraspFrame } from "@/domain/runtime/materialGraspFrames";

export class MaterialPoseObserver {
  constructor(
    readonly frames: ReadonlyMap<string, MaterialGraspFrames>,
    readonly supports: ReadonlyMap<string, TransportPosePolicy>,
    private devices: ReadonlyMap<string, SceneDevice>,
    private bodies: ReadonlyMap<string, RuntimeBody>,
    private physics: PhysicsPort,
  ) {}
  body(id: string) {
    const body = this.bodies.get(id + "/body");
    if (!body) throw new Error("Unknown material body: " + id);
    return body;
  }
  materialPose(id: string) {
    return this.physics.readBody!(this.body(id).id);
  }
  onBelt(id: string, device: string) {
    const body = this.body(id),
      policy = this.supports.get(device);
    if (
      !policy ||
      !this.physics.isBodyActive!(body.id) ||
      this.physics.hasGraspForBody!(body.id) ||
      !this.physics.hasContactSupport!(body.id, device + "/surface")
    )
      return false;
    const axis = new Vector3(...policy.axisLocal)
      .applyQuaternion(new Quaternion(...this.frames.get(id)!.rest))
      .applyQuaternion(new Quaternion(...this.materialPose(id).rotation));
    return (
      axis.dot(new Vector3(...policy.axisWorld)) > Math.cos(policy.maxTiltRad)
    );
  }
  atEndpoint(id: string, device: string, key: string) {
    if (!this.onBelt(id, device)) return false;
    const p = this.materialPose(id),
      f = selectGraspFrame(
        this.frames.get(id)!,
        this.supports.get(device)!.contactFrame,
      );
    const contact = new Vector3(...f.offset)
      .applyQuaternion(new Quaternion(...p.rotation))
      .add(new Vector3(...p.position));
    return (
      contact.distanceTo(
        new Vector3(...this.devices.get(device)!.locations[key].position),
      ) < 0.025
    );
  }
  checkPose(id: string, device: string, key: string) {
    if (!this.atEndpoint(id, device, key)) return false;
    const p = this.materialPose(id);
    return (
      Math.hypot(...p.velocity) < 0.02 &&
      Math.hypot(...(p.angularVelocity ?? [])) < 0.12
    );
  }
  targetPose(
    id: string,
    owner: string,
    key: string,
    graspPair?: [string, string],
  ): BodyPose {
    const loc = this.devices.get(owner)?.locations[key],
      desired = loc?.material_pose;
    if (!loc || !desired) throw new Error("缺少物料目标姿态 " + key);
    const frames = this.frames.get(id)!;
    const rotation = new Quaternion(...desired.orientation_quaternion).multiply(
      new Quaternion(...frames.rest).invert(),
    );
    const offset = (name: string) =>
      new Vector3(...selectGraspFrame(frames, name).offset);
    let reference: Vector3;
    if (desired.contact_frame) reference = offset(desired.contact_frame);
    else if (desired.reference === "grasp_frame_midpoint" && graspPair)
      reference = offset(graspPair[0]).lerp(offset(graspPair[1]), 0.5);
    else throw new Error("Unknown material pose reference: " + key);
    return {
      position: new Vector3(...loc.position)
        .sub(reference.applyQuaternion(rotation))
        .toArray(),
      rotation: rotation.toArray(),
      velocity: [0, 0, 0],
    };
  }
}

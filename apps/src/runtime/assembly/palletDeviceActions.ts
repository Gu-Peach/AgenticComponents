import { Quaternion, Vector3 } from "three";
import type {
  CompiledSceneRuntime,
  SceneDevice,
  Vec3,
} from "@/contracts/scene-execution";
import type {
  BodyPose,
  PhysicsPort,
  RuntimeBody,
  Quat,
} from "@/contracts/physics";
import type { CompiledRobotScene } from "@/contracts/robot";
import type { RobotStep } from "@/contracts/robot-command";
import { RobotKinematics } from "@/runtime/kinematics/RobotKinematics";
import type { PreparedRobotAction } from "@/runtime/adapters/scene/RobotSceneAdapter";
import {
  PositionTransportAdapter,
  type PositionTransportConfig,
  type TransportSubject,
  type TransportTarget,
} from "@/runtime/adapters/scene/PositionTransportAdapter";

export function bodyOf(c: CompiledSceneRuntime, id: string): RuntimeBody {
  const body = c.bodyMap.get(id + "/body");
  if (!body) throw new Error("Missing pallet-line body: " + id);
  return body;
}

function originOffset(device: SceneDevice, body: RuntimeBody): Vector3 {
  return new Vector3(...device.geometry.world_position).sub(
    new Vector3(...body.position),
  );
}

/** GLB-authored bottom-center coordinates follow the carrier's current Jolt pose. */
export function carrierPlacement(
  c: CompiledSceneRuntime,
  physics: PhysicsPort,
  carrierId: string,
  locationId: string,
  height: number,
) {
  const body = bodyOf(c, carrierId),
    carrier = c.devices.get(carrierId)!;
  const local = carrier.locations[locationId];
  if (!local || local.frame !== "carrier_local_m")
    throw new Error("Invalid carrier-local target: " + locationId);
  const pose = physics.readBody!(body.id),
    rotation = new Quaternion(...pose.rotation);
  const center = new Vector3(...local.position)
    .applyQuaternion(new Quaternion(...carrier.geometry.world_rotation))
    .add(originOffset(carrier, body))
    .add(new Vector3(0, height / 2, 0))
    .applyQuaternion(rotation)
    .add(new Vector3(...pose.position))
    .toArray();
  return { center, rotation, local };
}

export function homeAction(
  base: CompiledRobotScene,
  home: SceneDevice["locations"][string] | undefined,
): PreparedRobotAction {
  if (!home || home.frame !== "flange_pose_scene_world_m")
    throw new Error("Unknown robot retreat target");
  if (home.reference === "robot_rest_pose" && !home.rotation_quaternion)
    throw new Error("GLB 回位目标缺少法兰朝向");
  return {
    scene: base,
    returnToRest: home.reference === "robot_rest_pose",
    steps: [
      {
        kind: "move_to_pose",
        position: home.position,
        frame: "world",
        world_rotation: home.rotation_quaternion,
      },
    ],
  };
}

export function topPickAndPlace(
  base: CompiledRobotScene,
  material: string,
  load: RuntimeBody,
  pose: BodyPose,
  center: Vec3,
  rotation: Quat,
): PreparedRobotAction {
  const at = new Vector3(...pose.position),
    to = new Vector3(...center).add(new Vector3(0, 0.008, 0));
  const materialRotation = new Quaternion(...pose.rotation);
  const topNormal = new Vector3(0, 1, 0).applyQuaternion(materialRotation);
  const captureOffset = topNormal
    .clone()
    .multiplyScalar(load.size[1] / 2 + 0.025);
  const capture = at.clone().add(captureOffset);
  // On the GLB wrist the last roll axis passes through the flange. Choose its
  // outward end from the penultimate wrist pivot, then point it at the top face.
  const rest = new RobotKinematics(base).forward(
    base.model.urdf.joints.map(() => 0),
  );
  const rollAxis = rest.joints.at(-1)!.axis.clone();
  const wristToFlange = new Vector3(...rest.tcp.position).sub(
    rest.joints.at(-2)!.pivot,
  );
  const extension = rollAxis.dot(wristToFlange);
  if (Math.abs(extension) < 1e-6)
    throw new Error(
      "Cannot resolve the tool approach direction from the GLB wrist",
    );
  rollAxis.multiplyScalar(Math.sign(extension));
  const graspRotation = new Quaternion()
    .setFromUnitVectors(rollAxis, topNormal.clone().negate())
    .multiply(new Quaternion(...rest.tcp.rotation));
  // Preserve the tool/material relationship when retracting after a rotated placement.
  const materialTurn = new Quaternion(...rotation).multiply(
    materialRotation.clone().invert(),
  );
  const releaseRotation = materialTurn.clone().multiply(graspRotation);
  const safeY = Math.max(at.y, to.y) + base.liftHeight;
  const raised = new Vector3(at.x, safeY, at.z),
    above = new Vector3(to.x, safeY, to.z);
  const move = (pt: Vector3, orientation: Quaternion): RobotStep => ({
    kind: "move_to_pose",
    position: pt.toArray(),
    frame: "world",
    world_rotation: orientation.toArray(),
  });
  const held = (
    start: Vector3,
    end: Vector3,
    q0: Quat,
    q1: Quat,
  ): RobotStep[] =>
    Array.from({ length: 8 }, (_, i) => {
      const t = (i + 1) / 8;
      return {
        kind: "move_to_pose",
        subject: "held_material",
        position: start.clone().lerp(end, t).toArray(),
        frame: "world",
        world_rotation: new Quaternion(...q0)
          .slerp(new Quaternion(...q1), t)
          .toArray(),
      };
    });
  const steps: RobotStep[] = [
    move(
      capture.clone().addScaledVector(topNormal, base.liftHeight),
      graspRotation,
    ),
    move(capture, graspRotation),
    { kind: "grip", materialId: material },
    ...held(at, raised, pose.rotation, pose.rotation),
    ...held(raised, above, pose.rotation, rotation),
    ...held(above, to, rotation, rotation),
    { kind: "release", materialId: material },
    move(
      above.clone().add(captureOffset.applyQuaternion(materialTurn)),
      releaseRotation,
    ),
  ];
  return {
    scene: {
      ...base,
      materialInstanceId: material,
      subjectId: material,
      materialBodyId: load.id,
      materialSize: load.size,
      materialMass: load.mass,
      placementCenter: center,
      placementRotation: rotation,
    },
    steps,
  };
}

interface ConveyorGroupOptions {
  leader: string;
  members: string[];
  eligible: string[];
  targetLocations: ReadonlyMap<
    string,
    { position: Vec3; supportDevice: string }
  >;
  supplySupports: string[];
  palletExit?: string;
  releasePallet(id: string, target: TransportTarget, tick: number): boolean;
}
export function createConveyorGroup(
  sceneId: string,
  runId: string,
  c: CompiledSceneRuntime,
  physics: PhysicsPort,
  options: ConveyorGroupOptions,
) {
  const { leader: id, members, eligible, palletExit } = options;
  const group = c.devices.get(id)!;
  if (
    group.contract.device_type !== "conveyor" ||
    group.contract.version !== "1.2.0"
  )
    throw new Error("Unsupported pallet-line conveyor: " + id);
  const subjects = new Map<number, TransportSubject>();
  for (const name of eligible) {
    const body = bodyOf(c, name),
      index = c.subjectIds.get(name);
    if (!index) throw new Error("Missing transport subject ID: " + name);
    const referenceOffset: Vec3 = palletExit
      ? originOffset(c.devices.get(name)!, body).toArray()
      : [0, -body.size[1] / 2, 0];
    subjects.set(index, { id: name, bodyId: body.id, referenceOffset });
  }
  const drives = members.map((m) => {
    const device = c.devices.get(m)!;
    if (
      device.parameters.speed_mps !== group.parameters.speed_mps ||
      device.parameters.accel_time_s !== group.parameters.accel_time_s ||
      device.parameters.decel_time_s !== group.parameters.decel_time_s
    )
      throw new Error(
        "Coupled conveyors have different ramp parameters",
      );
    const surface = c.physics.surfaces?.find(
      (s) => s.id === m + "/surface" || s.aliases?.includes(m + "/surface"),
    );
    if (!surface)
      throw new Error("Drive is missing a physical surface: " + m);
    return { device: m, surfaceId: m + "/surface", flow: surface.direction };
  });
  const targets: TransportTarget[] = [];
  for (const [name, point] of options.targetLocations) {
    if (!name.startsWith(id + ".") || !members.includes(point.supportDevice))
      continue;
    const position = new Vector3(...point.position);
    if (name === palletExit) {
      const dir = new Vector3(...drives[0].flow);
      // Stop with the full carrier supported before passing it to the receiver.
      const inset = Math.max(
        ...eligible.map((p) => {
          const body = bodyOf(c, p),
            o = originOffset(c.devices.get(p)!, body);
          return (
            0.5 *
              body.size.reduce(
                (sum, d, i) => sum + d * Math.abs(dir.toArray()[i]),
                0,
              ) -
            o.dot(dir)
          );
        }),
      );
      position.addScaledVector(dir, -inset - 0.015);
    }
    targets.push({
      id: name,
      index: targets.length + 1,
      position: position.toArray(),
      supportIds: [point.supportDevice + "/surface"],
    });
  }
  const speed = Number(group.parameters.speed_mps);
  const cfg: PositionTransportConfig = {
    sceneId,
    runId,
    leader: id,
    drives,
    subjects,
    targets,
    publishDriveState: true,
    admissionSupportIds: options.supplySupports,
    maxSpeed: speed,
    acceleration: speed / Number(group.parameters.accel_time_s),
    deceleration: speed / Number(group.parameters.decel_time_s),
    positionTolerance: 0.015,
    verticalTolerance: 0.03,
    speedTolerance: 0.02,
    settleTicks: 3,
    inventoryFeedback: {
      partReadyPort: "part_ready",
      capacityPort: "capacity_available",
      capacity: Number(group.parameters.capacity),
    },
    releasePermissionPort: "release_waiting_material",
  };
  const belt = new PositionTransportAdapter(
    cfg,
    physics,
    palletExit
      ? (load, t, tick) => options.releasePallet(load.id, t, tick)
      : undefined,
  );
  return { belt, cfg };
}

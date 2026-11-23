import { Quaternion, Vector3 } from "three";
import { RobotKinematics } from "@/runtime/kinematics/RobotKinematics";
import type {
  CompiledSceneRuntime,
  SceneDevice,
  Vec3,
} from "@/contracts/scene-execution";
import type { PhysicsPort, RuntimeBody, Quat } from "@/contracts/physics";
import type { RobotStep } from "@/contracts/robot-command";
import type { ActionRequest } from "@/contracts/scheduler";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import {
  PositionTransportAdapter,
  type PositionTransportConfig,
  type TransportSubject,
  type TransportTarget,
} from "@/runtime/adapters/scene/PositionTransportAdapter";
import {
  RobotSceneAdapter,
  type PreparedRobotAction,
} from "@/runtime/adapters/scene/RobotSceneAdapter";

interface LoadingHooks {
  releasePallet(id: string, target: TransportTarget, tick: number): boolean;
}

function bodyOf(c: CompiledSceneRuntime, id: string): RuntimeBody {
  const body = c.bodyMap.get(id + "/body");
  if (!body) throw new Error("Missing loading body: " + id);
  return body;
}

function originOffset(device: SceneDevice, body: RuntimeBody): Vector3 {
  return new Vector3(...device.geometry.world_position).sub(
    new Vector3(...body.position),
  );
}

/** Authored carrier coordinates are in its GLB frame. Jolt's identity pose is the GLB world rest pose. */
export function palletPlacement(
  c: CompiledSceneRuntime,
  physics: PhysicsPort,
  material: string,
) {
  const pallet = c.loading!.pallets.find((p) =>
    p.items.some((item) => item.material === material),
  );
  if (!pallet)
    throw new Error("Material missing from pallet manifest: " + material);
  const item = pallet.items.find((row) => row.material === material)!;
  const palletBody = bodyOf(c, pallet.id),
    load = bodyOf(c, material);
  const carrier = c.devices.get(pallet.id)!;
  const local = carrier.locations[item.target];
  if (!local || local.frame !== "carrier_local_m")
    throw new Error("Invalid carrier-local loading target: " + item.target);
  const layer = local.support_layer;
  if (!layer) throw new Error("Missing declared support layer: " + item.target);
  const pose = physics.readBody!(palletBody.id);
  const q = new Quaternion(...pose.rotation);
  const center = new Vector3(...local.position)
    .applyQuaternion(new Quaternion(...carrier.geometry.world_rotation))
    .add(originOffset(carrier, palletBody))
    .add(new Vector3(0, load.size[1] / 2, 0))
    .applyQuaternion(q)
    .add(new Vector3(...pose.position))
    .toArray();
  const { loading_pose: policy } = c.devices.get(material)!.contract
    .type_specific_contract as {
    loading_pose?: {
      placement_yaw_rad: number;
      grasp_reference: string;
      placement_reference: string;
      rotation_axis_frame: string;
      rotation_axis: number[];
    };
  };
  if (
    !policy ||
    policy.grasp_reference !== "top_center" ||
    policy.placement_reference !== "bottom_center" ||
    policy.rotation_axis_frame !== "scene_world_m" ||
    !Array.isArray(policy.rotation_axis) ||
    policy.rotation_axis.length !== 3 ||
    policy.rotation_axis.some((v, i) => v !== (i === 1 ? 1 : 0)) ||
    !Number.isFinite(policy.placement_yaw_rad)
  )
    throw new Error("Unsupported loading grasp/placement policy: " + material);
  const yaw = policy.placement_yaw_rad;
  const rotation = q
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw))
    .toArray();
  const supports =
    layer === "deck"
      ? [palletBody.id]
      : pallet.items
          .filter((row) => row.category === layer)
          .map((row) => bodyOf(c, row.material).id);
  if (!supports.length)
    throw new Error("Declared support layer has no material: " + item.target);
  return {
    palletId: pallet.id,
    target: item.target,
    materialId: material,
    center,
    rotation,
    supports,
  };
}

/** Verify actual support, not just proximity to a slot or a completed animation. */
export function fitsLoadedSlot(
  c: CompiledSceneRuntime,
  physics: PhysicsPort,
  material: string,
): boolean {
  const load = bodyOf(c, material);
  if (!physics.isBodyActive?.(load.id) || physics.hasGraspForBody?.(load.id))
    return false;
  const slot = palletPlacement(c, physics, material);
  const pose = physics.readBody!(load.id);
  return (
    slot.supports.some((support) =>
      physics.hasContactSupport!(load.id, support),
    ) &&
    new Vector3(...pose.position).distanceTo(new Vector3(...slot.center)) <=
      0.025 &&
    new Quaternion(...pose.rotation).angleTo(
      new Quaternion(...slot.rotation),
    ) <= 0.07 &&
    Math.hypot(...pose.velocity) <= 0.04 &&
    Math.hypot(...(pose.angularVelocity ?? [])) <= 0.12
  );
}

function robotAction(
  c: CompiledSceneRuntime,
  physics: PhysicsPort,
  robot: string,
  request: ActionRequest,
): PreparedRobotAction {
  const base = c.robots.get(robot)!;
  const payload = request.payload as {
    binding?: string;
    fields?: Record<string, string>;
  };
  if (payload?.binding !== robot + "." + request.behavior || !payload.fields)
    throw new Error("Unbound loading robot payload");
  const p = payload.fields;
  if (request.behavior === "move_to_pose") {
    const home = c.devices.get(robot)?.locations[p.target];
    if (!home || home.frame !== "flange_pose_scene_world_m")
      throw new Error("Unknown loading robot retreat target");
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
  const config = c.loading!;
  const source = config.targets.get(p.source);
  const supply = config.supplies.find((s) => s.materials.includes(p.material));
  if (
    !source ||
    !supply ||
    !c.leaders.get(supply.leader)?.includes(source.supportDevice)
  )
    throw new Error("Wrong loading supply or source");
  const load = bodyOf(c, p.material),
    pose = physics.readBody!(load.id);
  const bottom = new Vector3(0, -load.size[1] / 2, 0)
    .applyQuaternion(new Quaternion(...pose.rotation))
    .add(new Vector3(...pose.position));
  if (
    bottom.distanceTo(new Vector3(...source.position)) > 0.04 ||
    Math.hypot(...pose.velocity) > 0.03 ||
    !physics.hasSupport(load.id, source.supportDevice + "/surface")
  )
    throw new Error(
      "Material has not stopped at its declared pickup point: " + p.source,
    );
  const slot = palletPlacement(c, physics, p.material);
  if (slot.target !== p.target)
    throw new Error("Robot target differs from loading manifest");
  const at = new Vector3(...pose.position),
    to = new Vector3(...slot.center).add(new Vector3(0, 0.008, 0));
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
  const materialTurn = new Quaternion(...slot.rotation).multiply(
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
    { kind: "grip", materialId: p.material },
    ...held(at, raised, pose.rotation, pose.rotation),
    ...held(raised, above, pose.rotation, slot.rotation),
    ...held(above, to, slot.rotation, slot.rotation),
    { kind: "release", materialId: p.material },
    move(
      above.clone().add(captureOffset.applyQuaternion(materialTurn)),
      releaseRotation,
    ),
  ];
  return {
    scene: {
      ...base,
      materialInstanceId: p.material,
      subjectId: p.material,
      materialBodyId: load.id,
      materialSize: load.size,
      materialMass: load.mass,
      placementCenter: slot.center,
      placementRotation: slot.rotation,
    },
    steps,
  };
}

export function createLoadingDevices(
  sceneId: string,
  runId: string,
  c: CompiledSceneRuntime,
  physics: PhysicsPort,
  hooks: LoadingHooks,
) {
  const config = c.loading!;
  const drivers: DeviceActionPort[] = [],
    configs = new Map<string, PositionTransportConfig>(),
    conveyors = new Map<string, PositionTransportAdapter>(),
    robots = new Map<string, RobotSceneAdapter>();
  for (const [id, members] of c.leaders) {
    const group = c.devices.get(id)!;
    if (
      group.contract.device_type !== "conveyor" ||
      group.contract.version !== "1.2.0"
    )
      throw new Error("Unsupported loading conveyor: " + id);
    const main = id === config.exchange.leader;
    const supplies = config.supplies.filter((s) => s.leader === id);
    const eligible = main
      ? config.pallets.map((p) => p.id)
      : supplies.flatMap((s) => s.materials);
    const subjects = new Map<number, TransportSubject>();
    for (const name of eligible) {
      const body = bodyOf(c, name),
        index = c.subjectIds.get(name);
      if (!index) throw new Error("Missing loading identity: " + name);
      const referenceOffset: Vec3 = main
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
          "Coupled loading conveyors have different ramp parameters",
        );
      const surface = c.physics.surfaces?.find(
        (s) => s.id === m + "/surface" || s.aliases?.includes(m + "/surface"),
      );
      if (!surface)
        throw new Error("Loading drive is missing a physical surface: " + m);
      return { device: m, surfaceId: m + "/surface", flow: surface.direction };
    });
    const targets: TransportTarget[] = [];
    for (const [name, point] of config.targets) {
      if (!name.startsWith(id + ".") || !members.includes(point.supportDevice))
        continue;
      const position = new Vector3(...point.position);
      if (main && name === config.exchange.exit) {
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
      admissionSupportIds: supplies.map((s) => s.device + "/surface"),
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
      main
        ? (load, t, tick) => hooks.releasePallet(load.id, t, tick)
        : undefined,
    );
    drivers.push(belt);
    configs.set(id, cfg);
    conveyors.set(id, belt);
  }
  for (const [id, base] of c.robots) {
    if (c.devices.get(id)?.contract.version !== "1.0.0")
      throw new Error("Unsupported loading robot: " + id);
    const robot = new RobotSceneAdapter(
      sceneId,
      runId,
      base,
      physics,
      (r) => robotAction(c, physics, id, r),
      (r) => {
        if (r.behavior !== "pick_and_place") return false;
        return fitsLoadedSlot(
          c,
          physics,
          (r.payload as { fields: { material: string } }).fields.material,
        );
      },
    );
    drivers.push(robot);
    robots.set(id, robot);
  }
  return { drivers, configs, conveyors, robots };
}

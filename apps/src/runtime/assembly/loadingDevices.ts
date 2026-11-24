/** 为托盘装载线创建输送带和机械臂适配器，根据当前托盘位姿和支承层计算放置位置，检查物料是否落入指定槽位。 */

import { getDeviceModule } from "@/devices/registry";
import { Quaternion, Vector3 } from "three";

import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import type { PhysicsPort } from "@/contracts/physics";
import type { ActionRequest } from "@/contracts/scheduler";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import type {
  PositionTransportAdapter,
  PositionTransportConfig,
  TransportTarget,
} from "@/devices/conveyor/behavior";
import type {
  RobotSceneAdapter,
  PreparedRobotAction,
} from "@/devices/robot_arm/behavior";

interface LoadingHooks {
  releasePallet(id: string, target: TransportTarget, tick: number): boolean;
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
  const palletBody = getDeviceModule("workpiece").bodyOf(c, pallet.id),
    load = getDeviceModule("workpiece").bodyOf(c, material);
  const {
    local,
    center,
    rotation: q,
  } = getDeviceModule("workpiece").carrierPlacement(
    c,
    physics,
    pallet.id,
    item.target,
    load.size[1],
  );
  const layer = local.support_layer;
  if (!layer) throw new Error("Missing declared support layer: " + item.target);
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
          .map(
            (row) => getDeviceModule("workpiece").bodyOf(c, row.material).id,
          );
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
  const load = getDeviceModule("workpiece").bodyOf(c, material);
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
    return getDeviceModule("robot_arm").homeAction(
      base,
      c.devices.get(robot)!.locations[p.target],
    );
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
  const load = getDeviceModule("workpiece").bodyOf(c, p.material),
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
  return getDeviceModule("robot_arm").topPickAndPlace(
    base,
    p.material,
    load,
    pose,
    slot.center,
    slot.rotation,
  );
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
    const main = id === config.exchange.leader;
    const supplies = config.supplies.filter((s) => s.leader === id);
    const eligible = main
      ? config.pallets.map((p) => p.id)
      : supplies.flatMap((s) => s.materials);
    const { belt, cfg } = getDeviceModule("conveyor").createGroup(
      sceneId,
      runId,
      c,
      physics,
      {
        leader: id,
        members,
        eligible,
        targetLocations: config.targets,
        supplySupports: supplies.map((s) => s.device + "/surface"),
        palletExit: main ? config.exchange.exit : undefined,
        releasePallet: hooks.releasePallet,
      },
    );
    drivers.push(belt);
    configs.set(id, cfg);
    conveyors.set(id, belt);
  }
  for (const [id, base] of c.robots) {
    if (c.devices.get(id)?.contract.version !== "1.0.0")
      throw new Error("Unsupported loading robot: " + id);
    const robot = getDeviceModule("robot_arm").createSceneDriver(
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

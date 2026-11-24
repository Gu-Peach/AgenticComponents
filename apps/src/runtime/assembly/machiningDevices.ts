/** 为托盘加工线创建输送带和机械臂适配器，生成原槽与机床加工点之间的抓放动作，并核对工件的落点和支承。 */

import { pickGraspForDevice } from "@/domain/runtime/materialGraspFrames";
import { getDeviceModule } from "@/devices/registry";
import { Quaternion, Vector3 } from "three";
import type { PhysicsPort } from "@/contracts/physics";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import type { ActionRequest } from "@/contracts/scheduler";
import type { TransportTarget } from "@/devices/conveyor/behavior";

function location(
  c: CompiledSceneRuntime,
  physics: PhysicsPort,
  material: string,
  target: string,
) {
  const machining = c.machining!;
  const load = getDeviceModule("workpiece").bodyOf(c, material);
  const pallet = machining.pallets.find((p) =>
    p.items.some((i) => i.material === material),
  );
  if (!pallet) throw new Error("Unknown machining material: " + material);
  if (target === machining.point) {
    const work = c.devices.get(machining.machine)!.locations[target];
    return {
      center: new Vector3(...work.position)
        .add(new Vector3(0, load.size[1] / 2, 0))
        .toArray(),
      rotation: load.rotation,
      support: machining.machine + "/support",
    };
  }
  if (c.devices.get(pallet.id)!.locations[target]?.frame !== "carrier_local_m")
    throw new Error("Unknown carrier slot: " + target);
  const { center, rotation } = getDeviceModule("workpiece").carrierPlacement(
    c,
    physics,
    pallet.id,
    target,
    load.size[1],
  );
  return {
    center,
    rotation: rotation.toArray(),
    support: getDeviceModule("workpiece").bodyOf(c, pallet.id).id,
  };
}

/** A part can travel fixed to its carrier after verified placement. A new release must first settle in contact. */
export function fitsMachiningLocation(
  c: CompiledSceneRuntime,
  physics: PhysicsPort,
  material: string,
  target: string,
  requireContact = false,
) {
  const load = getDeviceModule("workpiece").bodyOf(c, material);
  if (!physics.isBodyActive?.(load.id) || physics.hasGraspForBody?.(load.id))
    return false;
  const destination = location(c, physics, material, target);
  const pose = physics.readBody!(load.id);
  const supported =
    physics.hasContactSupport!(load.id, destination.support) ||
    (!requireContact &&
      target !== c.machining!.point &&
      physics.isCarriedBy!(load.id, destination.support));
  return (
    supported &&
    new Vector3(...pose.position).distanceTo(
      new Vector3(...destination.center),
    ) <= 0.025 &&
    new Quaternion(...pose.rotation).angleTo(
      new Quaternion(...destination.rotation),
    ) <= 0.07 &&
    Math.hypot(...pose.velocity) <= 0.04 &&
    Math.hypot(...(pose.angularVelocity ?? [])) <= 0.12
  );
}

export function createMachiningDevices(
  sceneId: string,
  runId: string,
  c: CompiledSceneRuntime,
  physics: PhysicsPort,
  hooks: {
    releasePallet(id: string, target: TransportTarget, tick: number): boolean;
  },
) {
  const m = c.machining!;
  const { belt, cfg } = getDeviceModule("conveyor").createGroup(
    sceneId,
    runId,
    c,
    physics,
    {
      leader: m.leader,
      members: c.leaders.get(m.leader)!,
      eligible: m.pallets.map((p) => p.id),
      targetLocations: m.targets,
      supplySupports: [c.sourceDevice + "/surface"],
      palletExit: m.exitTarget,
      releasePallet: hooks.releasePallet,
    },
  );
  const base = c.robots.get(m.robot)!;
  const fields = (r: ActionRequest) => {
    const payload = r.payload as {
      binding?: string;
      fields?: Record<string, string>;
    };
    if (payload?.binding !== m.robot + "." + r.behavior || !payload.fields)
      throw new Error("Unbound machining robot action");
    return payload.fields;
  };
  const robot = getDeviceModule("robot_arm").createSceneDriver(
    sceneId,
    runId,
    base,
    physics,
    (request) => {
      const p = fields(request);
      if (request.behavior === "move_to_pose")
        return getDeviceModule("robot_arm").homeAction(
          base,
          c.devices.get(m.robot)!.locations[p.target],
        );
      if (!fitsMachiningLocation(c, physics, p.material, p.source))
        throw new Error(
          "Machining part has not settled at its declared source: " + p.source,
        );
      const load = getDeviceModule("workpiece").bodyOf(c, p.material),
        pose = physics.readBody!(load.id);
      const target = location(c, physics, p.material, p.target);
      return getDeviceModule("robot_arm").topPickAndPlace(
        base,
        p.material,
        load,
        pose,
        target.center,
        target.rotation,
        pickGraspForDevice(c.devices.get(p.material)!, p.grasp),
      );
    },
    (request) => {
      if (request.behavior !== "pick_and_place") return false;
      const p = fields(request);
      return fitsMachiningLocation(c, physics, p.material, p.target, true);
    },
  );
  return {
    drivers: [belt, robot],
    configs: new Map([[m.leader, cfg]]),
    conveyors: new Map([[m.leader, belt]]),
    robots: new Map([[m.robot, robot]]),
  };
}

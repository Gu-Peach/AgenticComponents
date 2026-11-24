import {
  normalizeSceneCarrying,
  isCarryingWorkpiece,
  carryingProperties,
  validateCarrierManifest,
} from "@/devices/workpiece/behavior";
import { z } from "zod";
import {
  compileLoadingManifest,
  isLoadingBundle,
} from "./compileLoadingManifest";
import { compileWarehouseRuntime } from "./compileWarehouseRuntime";
import { compileHandoffManifest, materialPose } from "./compileHandoffManifest";
import { compileMachiningManifest } from "./compileMachiningManifest";
import { compileIndexedProcessing } from "./compileIndexedProcessing";
import { PropertyBinding, Quaternion, Vector3 } from "three";
import type { SceneBundle } from "@/contracts/scene-package";
import type {
  CompiledSceneRuntime,
  SceneDevice,
  SceneLoad,
  Vec3,
} from "@/contracts/scene-execution";
import type { RuntimeBody, RuntimeSurface } from "@/contracts/physics";
import { decodeProcessNode } from "@/contracts/process-ir";
import { compileSceneRobot } from "./compileSceneRobot";
import { RobotKinematics } from "@/runtime/kinematics/RobotKinematics";
import { SceneGeometryReader } from "./SceneGeometryReader";
import { mergeCoupledConveyors } from "./mergeCoupledConveyors";
const vec = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const deviceSchema = z.object({
  instance_id: z.string(),
  asset_kind: z.string().optional(),
  creation_policy: z.string().optional(),
  subject_id: z.number().optional(),
  initial_supply: z.string().optional(),
  prototype_ref: z.string().optional(),
  contract: z.record(z.string(), z.unknown()),
  parameters: z.record(
    z.string(),
    z.union([z.number(), z.string(), z.boolean()]),
  ),
  locations: z.record(
    z.string(),
    z.object({
      position: vec,
      frame: z.string(),
      owner: z.string().optional(),
      reference: z.string().optional(),
      rotation_quaternion: z
        .tuple([
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
        ])
        .optional(),
      support_device: z.string().optional(),
      support_layer: z.string().optional(),
      material_pose: materialPose.optional(),
    }),
  ),
  node_binding: z.object({
    status: z.string(),
    owned_mesh_indices: z.array(z.number().int()),
    model_sha256: z.string(),
  }),
  geometry: z.object({
    world_position: vec,
    world_rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    bounds: z.object({ min: vec, max: vec, size: vec }),
  }),
});
export function compileSceneRuntime(
  bundle: SceneBundle,
  modelBytes: ArrayBuffer,
  goal: unknown,
  mode: "run" | "validation" = "run",
): CompiledSceneRuntime {
  if (bundle.runtime_profile === "warehouse.virtual-linear@1")
    return compileWarehouseRuntime(bundle, modelBytes, goal, mode);
  const devices = new Map<string, SceneDevice>();
  const blockers: string[] = [],
    warnings: string[] = [];
  for (const raw of bundle.devices) {
    const rawPrefab = raw.prefab as { slot_support_node?: string } | undefined;
    const d = normalizeSceneCarrying(
      deviceSchema.parse(raw),
      rawPrefab?.slot_support_node,
    );
    if (
      devices.has(d.instance_id) ||
      d.node_binding.model_sha256 !== bundle.model_sha256
    )
      throw new Error("Device identity/model hash mismatch");
    devices.set(d.instance_id, d);
    if (!["bound", "prototype"].includes(d.node_binding.status))
      blockers.push(`${d.instance_id}: node binding unresolved`);
  }
  const root = decodeProcessNode(bundle.process.body);
  if (bundle.runtime_profile === "human-indexed-processing@1") {
    if (mode !== "validation")
      throw new Error("Indexed processing requires candidate simulation");
    if (blockers.length) throw new Error(blockers.join("\n"));
    const leaders = new Map<string, string[]>();
    const geometry = new SceneGeometryReader(modelBytes);
    const world = compilePalletWorld(
      bundle,
      geometry,
      devices,
      mode,
      warnings,
      leaders,
      new Map(),
      [],
    );
    const profile = compileIndexedProcessing(
      bundle,
      devices,
      geometry,
      world,
      goal,
      root,
    );
    warnings.push(
      "候选仿真采用人物直线搬运与虚拟吸附。机器人按加工端口位姿执行定时工步。",
    );
    return {
      bundle,
      root,
      devices,
      ...world,
      ...profile,
      leaders,
      readiness: { mode, warnings, blockers },
    };
  }
  const leaders = compileDriveGroups(bundle, devices, blockers);
  if (bundle.runtime_profile === "pallet-machining@1") {
    if (mode !== "validation")
      throw new Error("Machining requires candidate simulation");
    if (blockers.length) throw new Error(blockers.join("\n"));
    const { finishedByMaterial, ...manifest } = compileMachiningManifest(
      bundle,
      goal,
      root,
      devices,
      leaders,
    );
    validateCarrierManifest(manifest.task.pallets, devices);
    const world = compilePalletWorld(
      bundle,
      modelBytes,
      devices,
      mode,
      warnings,
      leaders,
      new Map([[manifest.sourceDevice, manifest.entryDevice]]),
      manifest.task.pallets,
    );
    // Loaded slot anchors may be projected onto the bound deck. Keep the
    // original visual rest transform and place only the simulated body.
    for (const pallet of manifest.task.pallets) {
      const carrier = devices.get(pallet.id)!;
      const rotation = new Quaternion(...carrier.geometry.world_rotation);
      for (const item of pallet.items) {
        const body = world.bodyMap.get(item.material + "/body")!;
        const original = devices.get(item.material)!.geometry.world_position;
        const offset = new Vector3(...carrier.locations[item.source].position)
          .applyQuaternion(rotation)
          .add(new Vector3(...carrier.geometry.world_position))
          .sub(new Vector3(...original));
        body.position = new Vector3(...body.position).add(offset).toArray();
      }
    }
    const hidden = new Set<number>();
    for (const binding of world.visualBodies) {
      const finished = finishedByMaterial.get(binding.instanceId);
      if (!finished) continue;
      const bounds = finished.geometry.bounds;
      binding.finishedVariant = {
        meshes: finished.node_binding.owned_mesh_indices,
        initial: {
          position: bounds.min.map((v, i) => (v + bounds.max[i]) / 2) as Vec3,
          rotation: [0, 0, 0, 1],
          velocity: [0, 0, 0],
        },
      };
      for (const index of binding.finishedVariant.meshes) hidden.add(index);
    }
    if (world.visualBodies.some((b) => b.meshes.some((i) => hidden.has(i))))
      throw new Error("Finished template overlaps active load geometry");
    const visibleMeshes = new Set(world.visualBodies.flatMap((b) => b.meshes));
    for (const d of devices.values())
      if (d.asset_kind === "material_prefab")
        for (const i of d.node_binding.owned_mesh_indices)
          if (!visibleMeshes.has(i)) hidden.add(i);
    warnings.push(
      "候选仿真采用机床台面碰撞代理。加工周期内保持同一工件刚体，完成时切换成品外观。",
    );
    return {
      bundle,
      root,
      devices,
      leaders,
      ...manifest,
      ...world,
      hiddenMeshes: [...hidden],
      readiness: { mode, warnings, blockers },
    };
  }
  if (bundle.runtime_profile === "robot-handoff@1") {
    if (mode !== "validation")
      throw new Error("Robot handoff requires candidate simulation");
    if (blockers.length) throw new Error(blockers.join("\n"));
    const manifest = compileHandoffManifest(bundle, root, devices, goal);
    const feederEntries = new Map([
      [manifest.sourceDevice, manifest.entryDevice],
    ]);
    warnings.push(
      "双臂交接采用候选运动学和虚拟夹具；输送姿态和支承由 Jolt 实测验证。",
    );
    return {
      bundle,
      root,
      devices,
      leaders,
      ...manifest,
      ...compilePalletWorld(
        bundle,
        modelBytes,
        devices,
        mode,
        warnings,
        leaders,
        feederEntries,
        [],
      ),
      readiness: { mode, warnings, blockers },
    };
  }
  if (isLoadingBundle(bundle)) {
    if (mode !== "validation")
      blockers.push("Loading requires explicit candidate simulation");
    if (blockers.length) throw new Error(blockers.join("\n"));
    const manifest = compileLoadingManifest(
      bundle,
      goal,
      root,
      devices,
      leaders,
    );
    validateCarrierManifest(manifest.loading.pallets, devices);
    const feederEntries = new Map(
      manifest.loading.supplies.map((s) => [s.device, s.entryDevice]),
    );
    warnings.push(
      "装载候选仿真采用输送支承代理与虚拟夹具。分层支承、机械臂可达性与满盘交付须依据实际运行反馈确认。",
    );
    return {
      bundle,
      root,
      ...manifest,
      devices,
      leaders,
      ...compilePalletWorld(
        bundle,
        modelBytes,
        devices,
        mode,
        warnings,
        leaders,
        feederEntries,
        [],
      ),
      readiness: { mode, warnings, blockers },
    };
  }
  const task = z
    .object({
      pallets: z.array(
        z.object({
          id: z.string(),
          items: z.array(
            z.object({
              material: z.string(),
              source: z.string(),
              category: z.string().optional(),
            }),
          ),
        }),
      ),
      material_count: z.number(),
      pallet_count: z.number(),
    })
    .passthrough()
    .parse(bundle.process.task);
  const goalData = z
    .object({
      expected: z.object({
        material_ids: z.array(z.string()),
        pallet_ids: z.array(z.string()),
        material_count: z.number().int().positive(),
        pallet_count: z.number().int().positive(),
      }),
      all: z.array(z.record(z.string(), z.unknown())),
    })
    .parse(goal);
  const goalKinds = [
    "category_deliveries",
    "all_pallets_empty_and_exited",
    "tools_empty",
    "drives_stopped",
    "no_active_requests",
    "no_pending_jobs",
    "operations_released",
  ];
  if (
    goalData.all.length !== goalKinds.length ||
    goalKinds.some(
      (kind) => goalData.all.filter((g) => g.kind === kind).length !== 1,
    )
  )
    throw new Error("Unsupported or incomplete independent goal profile");
  const deliveries = z
    .array(
      z.object({
        material: z.string(),
        category: z.string(),
        target: z.string(),
        handler: z.string(),
      }),
    )
    .parse(goalData.all.find((x) => x.kind === "category_deliveries")?.items);
  const ids = task.pallets.flatMap((p) => p.items.map((i) => i.material));
  if (
    JSON.stringify(ids) !== JSON.stringify(goalData.expected.material_ids) ||
    JSON.stringify(task.pallets.map((p) => p.id)) !==
      JSON.stringify(goalData.expected.pallet_ids) ||
    new Set(ids).size !== ids.length ||
    deliveries.length !== ids.length ||
    new Set(deliveries.map((d) => d.material)).size !== ids.length
  )
    throw new Error("Independent task identities differ");
  if (
    task.pallet_count !== task.pallets.length ||
    task.material_count !== ids.length ||
    goalData.expected.material_count !== ids.length ||
    goalData.expected.pallet_count !== task.pallets.length ||
    deliveries.some(
      (d) =>
        task.pallets
          .flatMap((p) => p.items)
          .find((i) => i.material === d.material)?.category !== d.category ||
        devices.get(d.handler)?.contract.device_type !== "robot_arm",
    ) ||
    deliveries.some((d) => !ids.includes(d.material))
  )
    throw new Error("Finite task cardinality or delivery identity mismatch");
  const owned = new Set<number>();
  for (const d of devices.values()) {
    if (
      d.creation_policy === "clone_on_admission" ||
      d.asset_kind?.endsWith("_prefab")
    )
      continue;
    for (const index of d.node_binding.owned_mesh_indices) {
      if (owned.has(index))
        throw new Error("Duplicate mesh ownership: " + index);
      owned.add(index);
    }
  }
  const subjectIds = new Map(
    [...ids.sort(), ...task.pallets.map((p) => p.id).sort()].map((id, i) => [
      id,
      i + 1,
    ]),
  );
  const environments = bundle.environment ?? [];
  const supply = environments.filter(
    (e) => e.kind === "finite_loaded_carrier_supply",
  );
  const exits = environments.filter((e) => e.kind === "empty_carrier_takeaway");
  if (supply.length !== 1 || exits.length !== 1)
    throw new Error(
      "This environment profile requires one finite carrier supply and receiver",
    );
  const sourceDevice = String(supply[0].source_device),
    entryLocation = String(supply[0].target),
    exitLocation = String(exits[0].source);
  const locationOwner = (location: string) => {
    const d = [...devices.values()].find((d) =>
      Object.hasOwn(d.locations, location),
    );
    if (!d) throw new Error("Unresolved location " + location);
    return d.instance_id;
  };
  const entryDevice = locationOwner(entryLocation),
    exitDevice = locationOwner(exitLocation);
  if (!devices.has(sourceDevice)) throw new Error("Missing supply support");
  const carrierGoal = z
    .object({ ids: z.array(z.string()), line: z.string() })
    .parse(goalData.all.find((g) => g.kind === "all_pallets_empty_and_exited"));
  if (
    carrierGoal.line !== exitDevice ||
    JSON.stringify(carrierGoal.ids) !==
      JSON.stringify(goalData.expected.pallet_ids)
  )
    throw new Error("Carrier exit goal differs from environment");
  const receivers = new Set(
    environments
      .filter((e) => e.kind === "material_takeaway")
      .flatMap((e) => z.array(z.string()).parse(e.sources)),
  );
  if (deliveries.some((d) => !receivers.has(d.target)))
    throw new Error("Material goal has no declared receiver");
  const outfeeds = [...new Set(deliveries.map((d) => locationOwner(d.target)))];
  if (!bundle.sorting_station)
    throw new Error(
      "Carrier sorting profile requires a declared process point",
    );
  if (mode === "run" && bundle.sorting_station.status === "candidate")
    blockers.push(
      "Process point is a calibration candidate; select explicit validation mode",
    );
  else
    warnings.push(
      "Candidate validation: GLB convex parts and declared support proxies; robot motion is kinematic and full-link collision avoidance is not modeled; coupled-proxy float32 geometry join tolerance is 10 micrometres.",
    );
  if (blockers.length) throw new Error(blockers.join("\n"));
  validateCarrierManifest(task.pallets, devices);
  const world = compilePalletWorld(
    bundle,
    modelBytes,
    devices,
    mode,
    warnings,
    leaders,
    new Map([[sourceDevice, entryDevice]]),
    task.pallets,
  );
  return {
    bundle,
    root,
    task: task as { pallets: SceneLoad[]; [key: string]: unknown },
    devices,
    ...world,
    subjectIds,
    sourceDevice,
    entryDevice,
    exitDevice,
    outfeeds,
    leaders,
    goals: { ...goalData.expected, deliveries },
    readiness: { mode, warnings, blockers },
  };
}

function compileDriveGroups(
  bundle: SceneBundle,
  devices: Map<string, SceneDevice>,
  blockers: string[],
) {
  const leaders = new Map<string, string[]>(),
    claimed = new Set<string>();
  for (const group of Object.values(bundle.drive_groups ?? {})) {
    const owners = [
      ...new Set(
        bundle.calls
          .filter(
            (c) =>
              group.members.includes(c.device) &&
              c.behavior === "transport_to_position",
          )
          .map((c) => c.device),
      ),
    ];
    if (owners.length !== 1)
      throw new Error(
        "Coupled group requires exactly one logical request owner",
      );
    for (const id of group.members) {
      if (
        claimed.has(id) ||
        devices.get(id)?.contract.device_type !== "conveyor"
      )
        throw new Error("Invalid/conflicting drive member");
      claimed.add(id);
    }
    leaders.set(owners[0], [...group.members]);
  }
  for (const call of bundle.calls) {
    const type = devices.get(call.device)?.contract.device_type;
    if (
      !["conveyor", "robot_arm"].includes(String(type)) &&
      !(
        bundle.runtime_profile === "pallet-machining@1" &&
        type === "machine_tool"
      )
    )
      blockers.push(`${call.device}.${call.behavior}: no registered factory`);
    if (type === "conveyor" && !claimed.has(call.device))
      leaders.set(call.device, [call.device]);
  }
  return leaders;
}

function compilePalletWorld(
  bundle: SceneBundle,
  modelBytes: ArrayBuffer | SceneGeometryReader,
  devices: Map<string, SceneDevice>,
  mode: "run" | "validation",
  warnings: string[],
  leaders: Map<string, string[]>,
  feederEntries: Map<string, string>,
  preloaded: SceneLoad[],
) {
  const geometry =
      modelBytes instanceof SceneGeometryReader
        ? modelBytes
        : new SceneGeometryReader(modelBytes),
    bodies: RuntimeBody[] = [],
    surfaces: RuntimeSurface[] = [],
    visualBodies: CompiledSceneRuntime["visualBodies"] = [],
    robots = new Map<string, ReturnType<typeof compileSceneRobot>>();
  const makeBody = (
    d: SceneDevice,
    role: RuntimeBody["role"],
    dynamic: boolean,
  ): RuntimeBody => {
    const b = d.geometry.bounds,
      center = b.min.map((v, i) => (v + b.max[i]) / 2) as Vec3;
    return {
      id: d.instance_id + "/body",
      instanceId: d.instance_id,
      role,
      motionType: dynamic ? "dynamic" : "static",
      position: center,
      rotation: [0, 0, 0, 1],
      size: b.size,
      mass: dynamic
        ? Number(d.parameters.mass_kg ?? d.parameters.empty_mass_kg)
        : undefined,
      friction: Number(d.parameters.friction ?? 0.6),
      restitution: Number(d.parameters.restitution ?? 0),
      initiallyActive: d.creation_policy !== "clone_on_admission",
    };
  };
  const hullCache = new Map<string, Vec3[][]>();
  for (const d of devices.values()) {
    if (d.asset_kind?.endsWith("_prefab")) continue;
    const type = d.contract.device_type;
    if (type === "conveyor") {
      const profile = z
        .object({
          surface: z.object({
            frame: z.literal("scene_world_m"),
            flow_axis: vec,
            candidate_support_height_m: z.number(),
            collision_proxy: z.object({
              kind: z.literal("box_surface"),
              thickness_m: z.number().positive(),
            }),
          }),
        })
        .parse(d.contract.type_specific_contract).surface;
      if (
        Math.abs(profile.flow_axis[1]) > 1e-6 ||
        Math.abs(Math.hypot(...profile.flow_axis) - 1) > 1e-6 ||
        Math.min(
          Math.abs(profile.flow_axis[0]),
          Math.abs(profile.flow_axis[2]),
        ) > 1e-6
      )
        throw new Error(
          "Only X/Z-aligned horizontal conveyor profiles are registered",
        );
      const body = makeBody(d, "conveying_support", false);
      body.size = [
        d.geometry.bounds.size[0],
        profile.collision_proxy.thickness_m,
        d.geometry.bounds.size[2],
      ];
      body.position[1] = profile.candidate_support_height_m - body.size[1] / 2;
      bodies.push(body);
      surfaces.push({
        id: d.instance_id + "/surface",
        bodyId: body.id,
        direction: profile.flow_axis,
        normal: [0, 1, 0],
      });
    } else if (
      type === "machine_tool" &&
      bundle.runtime_profile === "pallet-machining@1"
    ) {
      const spec = z
        .object({
          support_mesh_node: z.string(),
          support_meshes: z.array(z.number().int().nonnegative()).length(1),
        })
        .parse(d.contract.type_specific_contract);
      const index = spec.support_meshes[0];
      if (
        !d.node_binding.owned_mesh_indices.includes(index) ||
        bundle.nodes[index]?.name !== spec.support_mesh_node
      )
        throw new Error(
          "Machine table mesh is outside bound device: " + d.instance_id,
        );
      const [vertices] = geometry.convexParts([index], [0, 0, 0]);
      if (!vertices) throw new Error("Missing machine table geometry");
      const lo: Vec3 = [Infinity, Infinity, Infinity],
        hi: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const v of vertices)
        for (let axis = 0; axis < 3; axis++) {
          lo[axis] = Math.min(lo[axis], v[axis]);
          hi[axis] = Math.max(hi[axis], v[axis]);
        }
      const anchor = Object.values(d.locations)[0].position;
      if (
        anchor[0] < lo[0] ||
        anchor[0] > hi[0] ||
        anchor[2] < lo[2] ||
        anchor[2] > hi[2] ||
        Math.abs(anchor[1] - hi[1]) > 0.002
      )
        throw new Error("Machining point does not lie on its bound support");
      bodies.push({
        id: d.instance_id + "/support",
        instanceId: d.instance_id,
        motionType: "static",
        role: "support",
        position: lo.map((v, i) => (v + hi[i]) / 2) as Vec3,
        size: hi.map((v, i) => v - lo[i]) as Vec3,
        rotation: [0, 0, 0, 1],
        friction: Number(d.parameters.friction ?? 0.6),
        restitution: 0,
      });
    } else if (feederEntries.has(d.instance_id)) {
      const body = makeBody(d, "conveying_support", false);
      bodies.push(body);
      const flow = z
        .object({ surface: z.object({ flow_axis: vec }) })
        .parse(
          devices.get(feederEntries.get(d.instance_id)!)!.contract
            .type_specific_contract,
        ).surface.flow_axis;
      surfaces.push({
        id: d.instance_id + "/surface",
        bodyId: body.id,
        direction: flow,
        normal: [0, 1, 0],
      });
      warnings.push(
        `${d.instance_id}: finite supply uses a simulated contact-feed surface`,
      );
    } else if (type === "workpiece") {
      const body = makeBody(
        d,
        isCarryingWorkpiece(d.contract) ? "carrier" : "material",
        true,
      );
      const key = JSON.stringify([
        d.node_binding.owned_mesh_indices,
        body.position,
      ]);
      const parts =
        hullCache.get(key) ??
        geometry.convexParts(d.node_binding.owned_mesh_indices, body.position);
      hullCache.set(key, parts);
      if (!parts.length)
        throw new Error("Missing collision geometry " + d.instance_id);
      body.convexParts = parts;
      bodies.push(body);
      visualBodies.push({
        bodyId: body.id,
        instanceId: d.instance_id,
        meshes: d.node_binding.owned_mesh_indices,
        initial: {
          position: body.position,
          rotation: body.rotation,
          velocity: [0, 0, 0],
        },
        future: d.creation_policy === "clone_on_admission",
      });
    } else if (type === "robot_arm") {
      const robot = compileSceneRobot(d, 0, {
        allowCandidate: mode === "validation",
      });
      robots.set(d.instance_id, robot);
      const pose = new RobotKinematics(robot).forward([0, 0, 0, 0, 0, 0]).tcp;
      bodies.push({
        id: robot.toolBodyId,
        instanceId: d.instance_id,
        motionType: "kinematic",
        role: "tool",
        position: pose.position,
        rotation: pose.rotation,
        size: robot.model.gripper.tool_size_m,
        friction: 0.5,
        restitution: 0,
      });
    }
  }
  bodies.push({
    id: "world/ground",
    instanceId: "world",
    motionType: "static",
    role: "ground",
    position: [0, -0.06, 0],
    rotation: [0, 0, 0, 1],
    size: [100, 0.1, 100],
    friction: 0.6,
    restitution: 0,
  });
  const first = bodies.find(
    (b) => b.role === "carrier" || b.role === "material",
  );
  if (!first) throw new Error("No finite load bodies");
  const carrierBindings = preloaded.flatMap((p) => {
    const carrier = devices.get(p.id)!;
    const carrying = carryingProperties(carrier.contract);
    if (!carrying)
      throw new Error(
        "Preloaded inventory requires carrying properties: " + p.id,
      );
    const mode = carrying.load_motion_mode ?? "physical_support";
    if (mode === "rigid_compound")
      throw new Error("Unsupported compound carrier load mode");
    return mode === "relative_constraint"
      ? p.items.map((i) => ({
          carrier: p.id + "/body",
          material: i.material + "/body",
        }))
      : [];
  });
  let physics: CompiledSceneRuntime["physics"] = {
    bodies,
    surfaces,
    carrierBindings,
    targetBodyId: first.id,
    surfacePosition: [0, 0, 0],
    surfaceSize: [1, 0.1, 1],
    rotation: [0, 0, 0, 1],
    materialPosition: first.position,
    materialSize: first.size,
    mass: first.mass!,
    friction: 0.6,
  };
  for (const [leader, members] of leaders)
    if (members.length > 1)
      physics = mergeCoupledConveyors(
        physics,
        members.map((id) => id + "/surface"),
        "drive-group/" + leader,
        1e-5,
      );
  const robotNodes = new Map(
    [...robots].map(([id, robot]) => [
      id,
      robot.model.urdf.joints.map((j) => {
        const matching = bundle.nodes.filter(
          (n) => PropertyBinding.sanitizeNodeName(n.name) === j.nodeName,
        );
        if (matching.length !== 1)
          throw new Error(
            `Missing or ambiguous robot render node: ${id}/${j.nodeName}`,
          );
        return matching[0].index;
      }),
    ]),
  );
  return {
    physics,
    bodyMap: new Map(physics.bodies!.map((b) => [b.id, b])),
    visualBodies,
    robots,
    robotNodes,
  };
}

import { alignedMountFrames, mountParents } from "@/domain/spatial/mounts";
import { spatialInterfaceSchema } from "@/contracts/spatial";
import { Matrix4, Quaternion, Vector3 } from "three";
import { z } from "zod";
import type { SceneBundle } from "@/contracts/scene-package";
import type {
  CompiledSceneRuntime,
  SceneDevice,
  Vec3,
  VisualBodyBinding,
} from "@/contracts/scene-execution";
import type { RuntimeBody } from "@/contracts/physics";
import type { WarehouseConfig, WarehouseAssembly } from "@/contracts/warehouse";
import { decodeProcessNode, childrenOf } from "@/contracts/process-ir";
import { SceneGeometryReader } from "./SceneGeometryReader";
import { resolveDock } from "./DockingTargetResolver";
const vec = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const geometrySchema = z.object({
  world_position: vec,
  world_rotation: quat,
  bounds: z.object({ min: vec, max: vec, size: vec }),
});
const simulationSchema = z.object({
  profile: z.literal("warehouse.virtual-linear@1"),
  axis_local: vec.optional(),
  limits_m: z.tuple([z.number(), z.number()]).optional(),
  root_rotation: quat,
  platform_geometry: geometrySchema.optional(),
  platform_meshes: z.array(z.number()).optional(),
  anchor_local_m: vec.optional(),
  support_size_m: vec.optional(),
  support_geometry: geometrySchema.optional(),
  flow_world: vec.optional(),
});
const jobSchema = z
  .object({
    id: z.string(),
    material: z.string(),
    input: z.string(),
    slot: z.string(),
    target: z.string(),
  })
  .passthrough();
export function compileWarehouseRuntime(
  bundle: SceneBundle,
  bytes: ArrayBuffer,
  rawGoal: unknown,
  mode: "run" | "validation",
): CompiledSceneRuntime {
  if (mode !== "validation")
    throw new Error(
      "Warehouse virtual transfer requires explicit candidate validation",
    );
  const task = z
    .object({
      jobs: z.array(jobSchema).min(1),
      pallets: z.array(z.unknown()).length(0),
      material_count: z.number(),
      pallet_count: z.literal(0),
    })
    .passthrough()
    .parse(bundle.process.task);
  const root = decodeProcessNode(bundle.process.body);
  const calls: { device: string; behavior: string }[] = [];
  const visit = (n: typeof root) => {
    if (n.kind === "invoke") {
      if (n.device.kind !== "ref") throw new Error("Unbound warehouse device");
      calls.push({ device: n.device.name, behavior: n.behavior });
    }
    childrenOf(n).forEach(visit);
  };
  visit(root);
  const goal = z
    .object({
      expected: z.object({
        material_ids: z.array(z.string()),
        material_count: z.number(),
        pallet_count: z.literal(0),
        pallet_ids: z.array(z.string()).length(0),
      }),
      all: z.array(z.record(z.string(), z.unknown())),
    })
    .parse(rawGoal);
  const ids = task.jobs.map((j) => j.material),
    kinds = [
      "all_delivered_once",
      "stored_before_retrieved",
      "tools_empty",
      "drives_stopped",
      "no_active_requests",
      "no_pending_jobs",
      "operations_released",
    ];
  if (
    new Set(ids).size !== ids.length ||
    task.material_count !== ids.length ||
    goal.expected.material_count !== ids.length ||
    JSON.stringify(goal.expected.material_ids) !== JSON.stringify(ids) ||
    goal.all.length !== kinds.length ||
    kinds.some((k) => goal.all.filter((g) => g.kind === k).length !== 1)
  )
    throw new Error("Warehouse independent goal/identities differ");
  for (const [kind, key] of [
    ["all_delivered_once", "target"],
    ["stored_before_retrieved", "slot"],
  ] as const) {
    const items = z
      .array(
        z.object({
          material: z.string(),
          target: z.string().optional(),
          slot: z.string().optional(),
        }),
      )
      .parse(goal.all.find((g) => g.kind === kind)!.items);
    if (
      items.length !== ids.length ||
      new Set(items.map((i) => i.material)).size !== ids.length ||
      task.jobs.some(
        (j) => items.find((i) => i.material === j.material)?.[key] !== j[key],
      )
    )
      throw new Error("Warehouse independent route differs");
  }
  const devices = new Map<string, SceneDevice>(),
    rawDevices = new Map(bundle.devices.map((d) => [d.instance_id, d]));
  for (const d of bundle.devices) {
    if (
      d.node_binding.model_sha256 !== bundle.model_sha256 ||
      !["bound", "prototype"].includes(d.node_binding.status)
    )
      throw new Error("Warehouse geometry is unbound/stale");
    const parsed = z
      .object({
        instance_id: z.string(),
        contract: z.record(z.string(), z.unknown()),
        parameters: z.record(
          z.string(),
          z.union([z.number(), z.string(), z.boolean()]),
        ),
        locations: z
          .record(
            z.string(),
            z.object({ position: vec, frame: z.literal("scene_world_m") }),
          )
          .default({}),
        node_binding: z.object({
          status: z.string(),
          model_sha256: z.string(),
          owned_mesh_indices: z.array(z.number()),
        }),
        geometry: geometrySchema,
        asset_kind: z.string().optional(),
        creation_policy: z.string().optional(),
      })
      .parse(d);
    if (devices.has(parsed.instance_id)) throw new Error("Duplicate device");
    devices.set(parsed.instance_id, parsed);
  }
  const physicsReader = new SceneGeometryReader(bytes),
    bodies: RuntimeBody[] = [],
    visualBodies: VisualBodyBinding[] = [],
    usedMeshes = new Set<number>();
  const identity: [number, number, number, number] = [0, 0, 0, 1];
  const make = (
    id: string,
    owner: string,
    position: Vec3,
    size: Vec3,
    role: RuntimeBody["role"],
    motionType: RuntimeBody["motionType"],
    meshes: number[] = [],
    convex = false,
    future = false,
  ) => {
    if (size.some((v) => v <= 0) || bodies.some((b) => b.id === id))
      throw new Error("Invalid body geometry");
    if (!future)
      for (const m of meshes) {
        if (usedMeshes.has(m))
          throw new Error("Duplicate warehouse mesh ownership");
        usedMeshes.add(m);
      }
    const b: RuntimeBody = {
      id,
      instanceId: owner,
      position,
      size,
      rotation: identity,
      role,
      motionType,
      friction: 0.7,
      restitution: 0,
      ...(convex
        ? { convexParts: physicsReader.convexParts(meshes, position) }
        : {}),
    };
    bodies.push(b);
    if (meshes.length)
      visualBodies.push({
        bodyId: id,
        instanceId: owner,
        meshes,
        initial: { position, rotation: identity, velocity: [0, 0, 0] },
        future,
      });
    return b;
  };
  const center = (g: z.infer<typeof geometrySchema>) =>
    g.bounds.min.map((v, i) => (v + g.bounds.max[i]) / 2) as Vec3;
  const simulations = new Map<string, z.infer<typeof simulationSchema>>();
  const specific = (id: string) =>
    z
      .record(z.string(), z.unknown())
      .parse(devices.get(id)!.contract.type_specific_contract);
  const config: WarehouseConfig = {
    jobs: task.jobs,
    locations: new Map(),
    assemblies: [],
    conveyors: new Map(),
    materials: new Map(),
    source: "",
  };
  for (const [id, d] of devices) {
    if (d.asset_kind?.endsWith("_prefab")) continue;
    const type = d.contract.device_type;
    if (["linear_rail", "lift_table", "conveyor"].includes(String(type)))
      simulations.set(id, simulationSchema.parse(specific(id).simulation));
    if (type === "conveyor") {
      if (!["1.1.0", "1.2.0"].includes(String(d.contract.version)))
        throw new Error("Unsupported conveyor version");
      const s = simulations.get(id)!,
        g = s.support_geometry!;
      if (!g || !s.flow_world) throw new Error("Missing belt calibration");
      const top = center(g);
      top[1] = g.bounds.max[1] - 0.005;
      make(
        id + "/surface",
        id,
        top,
        [g.bounds.size[0], 0.01, g.bounds.size[2]],
        "conveying_support",
        "static",
        d.node_binding.owned_mesh_indices,
      );
      config.conveyors.set(id, {
        entry: id + ".entry",
        exit: id + ".exit",
        flow: s.flow_world,
        speed: Number(d.parameters.speed_mps),
      });
      for (const [key, l] of Object.entries(d.locations))
        config.locations.set(key, {
          id: key,
          owner: id,
          position: l.position,
          support: id + "/surface",
          size: g.bounds.size,
          kind: "conveyor",
        });
    } else if (type === "storage_rack") {
      if (d.contract.version !== "1.0.0")
        throw new Error("Unsupported rack version");
      make(
        id + "/body",
        id,
        center(d.geometry),
        d.geometry.bounds.size,
        "support",
        "static",
        d.node_binding.owned_mesh_indices,
        true,
      );
      for (const [key, l] of Object.entries(d.locations))
        config.locations.set(key, {
          id: key,
          owner: id,
          position: l.position,
          support: id + "/body",
          size: [
            Number(d.parameters.cell_width_m),
            Number(d.parameters.cell_height_m),
            Number(d.parameters.cell_depth_m),
          ],
          kind: "slot",
        });
    } else if (type === "linear_rail") {
      if (d.contract.version !== "1.1.0")
        throw new Error("Unsupported rail version");
      make(
        id + "/body",
        id,
        center(d.geometry),
        d.geometry.bounds.size,
        "support",
        "static",
        d.node_binding.owned_mesh_indices,
        true,
      );
    } else if (type === "workpiece") {
      if (!ids.includes(id)) throw new Error("Unregistered material");
      const b = make(
        id + "/body",
        id,
        center(d.geometry),
        d.geometry.bounds.size,
        "material",
        "dynamic",
        d.node_binding.owned_mesh_indices,
        false,
        d.creation_policy === "clone_on_admission",
      );
      b.initiallyActive = false;
      b.mass = Number(d.parameters.mass_kg);
      if (!Number.isFinite(b.mass) || b.mass <= 0)
        throw new Error("Invalid load mass");
      config.materials.set(id, { body: b.id, size: b.size });
    } else if (type === "material_source_station") {
      make(
        id + "/body",
        id,
        center(d.geometry),
        d.geometry.bounds.size,
        "support",
        "static",
        d.node_binding.owned_mesh_indices,
        true,
      );
    } else if (type !== "lift_table")
      throw new Error("Unsupported warehouse type");
  }
  // An explicit empty connection list means disconnected. Old snapshots use the paired instance fields.
  const ports = new Map(
    [...devices].map(([id, d]) => [
      id,
      z.array(spatialInterfaceSchema).parse(d.contract.interfaces ?? []),
    ]),
  );
  const portAt = (e: { instanceId: string; interfaceId: string }) =>
    ports.get(e.instanceId)?.find((p) => p.interface_id === e.interfaceId);
  const parents =
    bundle.connections && mountParents(bundle.connections, portAt);
  for (const link of bundle.connections ?? []) {
    const first = portAt(link.a),
      second = portAt(link.b);
    if (
      !first?.local_frame ||
      !second?.local_frame ||
      ![first, second].some(
        (p) => p.capabilities.snap.role === "carriage_mount",
      )
    )
      continue;
    const world = (id: string) => {
      const g = devices.get(id)!.geometry;
      return new Matrix4().compose(
        new Vector3(...g.world_position),
        new Quaternion(...g.world_rotation),
        new Vector3(1, 1, 1),
      );
    };
    if (
      !alignedMountFrames(
        first.local_frame,
        world(link.a.instanceId),
        second.local_frame,
        world(link.b.instanceId),
      )
    )
      throw new Error("Installed mount frames are not aligned: " + link.id);
  }
  for (const [id, d] of devices) {
    if (d.contract.device_type !== "lift_table") continue;
    if (d.contract.version !== "1.2.0")
      throw new Error("Unsupported lift version");
    const s = simulations.get(id)!,
      sp = specific(id),
      rail = parents
        ? (parents.get(id)?.instanceId ?? "")
        : String(sp.mounted_on),
      rd = devices.get(rail),
      rs = simulations.get(rail);
    if (
      !rd ||
      !rs ||
      rd.contract.device_type !== "linear_rail" ||
      (!parents && specific(rail).mounted_device !== id) ||
      (sp.mounted_on !== undefined && sp.mounted_on !== rail) ||
      (specific(rail).mounted_device !== undefined &&
        specific(rail).mounted_device !== id) ||
      !s.platform_geometry ||
      !s.platform_meshes ||
      !s.support_size_m ||
      !s.anchor_local_m ||
      !s.limits_m ||
      !rs.axis_local ||
      !rs.limits_m
    )
      throw new Error("Incomplete mounted lift");
    const rotation = new Quaternion(...s.platform_geometry.world_rotation),
      axis = new Vector3(...rs.axis_local)
        .applyQuaternion(new Quaternion(...rs.root_rotation))
        .normalize()
        .toArray();
    if (Math.abs(axis[1]) > 1e-6)
      throw new Error("Only horizontal rail supported");
    const anchor = new Vector3(...s.anchor_local_m)
      .applyQuaternion(rotation)
      .add(new Vector3(...s.platform_geometry.world_position))
      .toArray();
    const platform = id + "/platform",
      mast = id + "/mast",
      tool = id + "/transfer-tool",
      p = [...anchor] as Vec3;
    p[1] -= s.support_size_m[1] / 2;
    make(
      platform,
      id,
      p,
      s.support_size_m,
      "support",
      "kinematic",
      s.platform_meshes,
    );
    const mastMeshes = d.node_binding.owned_mesh_indices.filter(
      (i) => !s.platform_meshes!.includes(i),
    );
    make(
      mast,
      id,
      center(d.geometry),
      d.geometry.bounds.size,
      "support",
      "kinematic",
      mastMeshes,
      true,
    );
    const t = make(
      tool,
      id,
      [anchor[0], anchor[1] + 5, anchor[2]],
      [0.01, 0.01, 0.01],
      "tool",
      "kinematic",
    );
    t.sensor = true;
    const routes = z
      .array(
        z.object({
          sources: z.array(z.string()),
          targets: z.array(z.string()),
        }),
      )
      .parse(rawDevices.get(id)!.transfer_routes);
    const a: WarehouseAssembly = {
      rail,
      lift: id,
      axis,
      vertical: [0, 1, 0],
      anchor,
      platform,
      mast,
      tool,
      railLimits: rs.limits_m,
      liftLimits: s.limits_m,
      railSpeed: Number(rd.parameters.travel_speed_mps),
      railAccel: Number(rd.parameters.travel_accel_mps2),
      liftSpeed: Number(d.parameters.lift_speed_mps),
      liftAccel: Number(d.parameters.lift_accel_mps2),
      transferSpeed: Number(d.parameters.transfer_speed_mps),
      transferAccel: Number(d.parameters.transfer_accel_mps2),
      maxTransfer: Number(d.parameters.transfer_max_distance_m),
      restHeight: anchor[1] - d.geometry.world_position[1],
      routes,
    };
    config.assemblies.push(a);
    config.locations.set(id + ".work", {
      id: id + ".work",
      owner: id,
      position: anchor,
      support: platform,
      size: s.support_size_m,
      kind: "platform",
    });
  }
  if (config.assemblies.length === 0 || config.materials.size !== ids.length)
    throw new Error("Missing assemblies/materials");
  for (const a of config.assemblies)
    for (const r of a.routes)
      for (const key of [...r.sources, ...r.targets]) {
        const l = config.locations.get(key);
        if (!l) throw new Error("Unknown transfer route");
        if (l.kind !== "platform") resolveDock(a, l);
      }
  const supply =
    bundle.environment?.filter((e) => e.kind === "finite_material_supply") ??
    [];
  if (
    supply.length !== 1 ||
    devices.get(String(supply[0].source_device))?.contract.device_type !==
      "material_source_station"
  )
    throw new Error("Finite material supply missing");
  config.source = String(supply[0].source_device);
  const targets =
    bundle.environment
      ?.filter((e) => e.kind === "material_takeaway")
      .flatMap((e) => z.array(z.string()).parse(e.sources)) ?? [];
  if (
    task.jobs.some(
      (j) =>
        j.input !== supply[0].target ||
        !config.locations.has(j.slot) ||
        !targets.includes(j.target),
    )
  )
    throw new Error("Goal endpoint has no environment service");
  const admitted: Record<string, string[]> = {
    linear_rail: ["move_to_location", "move_to_position", "stop_motion"],
    lift_table: [
      "lift_to_location",
      "lift_to_level",
      "accept_material",
      "release_material",
      "transfer_material",
      "hold_lift",
    ],
    conveyor: ["transport_to_exit", "stop_conveying", "release_material"],
  };
  for (const c of calls)
    if (
      !admitted[String(devices.get(c.device)?.contract.device_type)]?.includes(
        c.behavior,
      )
    )
      throw new Error("Unimplemented warehouse behavior");
  const first = bodies.find((b) => b.role === "material")!;
  return {
    warehouse: config,
    bundle,
    root,
    task: { ...task, pallets: [] },
    devices,
    physics: {
      bodies,
      surfaces: [...config.conveyors].map(([id, c]) => ({
        id: id + "/surface",
        bodyId: id + "/surface",
        direction: c.flow,
        normal: [0, 1, 0],
      })),
      targetBodyId: first.id,
      surfacePosition: [0, 0, 0],
      surfaceSize: [1, 1, 1],
      rotation: identity,
      materialPosition: first.position,
      materialSize: first.size,
      mass: first.mass!,
      friction: 0.7,
    },
    bodyMap: new Map(bodies.map((b) => [b.id, b])),
    visualBodies,
    robots: new Map(),
    robotNodes: new Map(),
    subjectIds: new Map(ids.map((id, i) => [id, i + 1])),
    sourceDevice: config.source,
    entryDevice: config.locations.get(task.jobs[0].input)!.owner,
    exitDevice: config.locations.get(task.jobs[0].target)!.owner,
    outfeeds: [
      ...new Set(task.jobs.map((j) => config.locations.get(j.target)!.owner)),
    ],
    leaders: new Map([...config.conveyors.keys()].map((k) => [k, [k]])),
    goals: {
      material_ids: ids,
      pallet_ids: [],
      deliveries: task.jobs.map((j) => ({
        material: j.material,
        target: j.target,
        handler: "",
      })),
    },
    readiness: {
      mode,
      warnings: [
        "Candidate virtual-linear warehouse: declared platform/belt supports, GLB rack geometry, fixed-constraint transfer; no physical fork or hardware calibration.",
      ],
      blockers: [],
    },
  };
}

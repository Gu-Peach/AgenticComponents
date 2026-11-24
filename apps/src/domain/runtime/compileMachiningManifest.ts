import { z } from "zod";
import { childrenOf, type ProcessNode } from "@/contracts/process-ir";
import type { MachiningConfig, SceneDevice } from "@/contracts/scene-execution";
import type { SceneBundle } from "@/contracts/scene-package";
import { checkCarrierCalls, sameIds } from "./compileLoadingManifest";

const name = z.string().min(1);
const taskSchema = z
  .object({
    pallets: z
      .array(
        z.object({
          id: name,
          prototype_ref: name,
          items: z
            .array(
              z.object({
                material: name,
                source: name,
                category: z.literal("raw"),
              }),
            )
            .nonempty(),
        }),
      )
      .nonempty(),
    pallet_count: z.number().int().positive(),
    material_count: z.number().int().positive(),
    max_items_per_pallet: z.number().int().positive(),
  })
  .passthrough();
const goalSchema = z.object({
  scene_id: name,
  expected: z.object({
    material_ids: z.array(name),
    pallet_ids: z.array(name),
    material_count: z.number().int().positive(),
    pallet_count: z.number().int().positive(),
  }),
  all: z.array(z.object({ kind: name }).passthrough()),
});
const goalKinds = [
  "processed_and_returned",
  "all_pallets_loaded_and_departed",
  "tools_empty",
  "drives_stopped",
  "no_active_requests",
  "no_pending_jobs",
  "operations_released",
];
const processingSpec = z.object({
  processing: z.object({
    initial_state: z.literal("raw"),
    finished_state: z.literal("finished"),
    finished_template: name,
  }),
});

export function compileMachiningManifest(
  bundle: SceneBundle,
  goalInput: unknown,
  root: ProcessNode,
  devices: Map<string, SceneDevice>,
  leaders: Map<string, string[]>,
) {
  checkCarrierCalls(bundle, root, devices, {
    "machine_tool@1.0.0": new Set(["machine_material"]),
  });
  const task = taskSchema.parse(bundle.process.task),
    goal = goalSchema.parse(goalInput);
  const pallets = task.pallets,
    palletIds = pallets.map((p) => p.id);
  const items = pallets.flatMap((p) => p.items),
    materialIds = items.map((i) => i.material);
  if (
    goal.scene_id !== bundle.id ||
    !sameIds(
      goal.all.map((g) => g.kind),
      goalKinds,
    ) ||
    !sameIds(goal.expected.pallet_ids, palletIds) ||
    !sameIds(goal.expected.material_ids, materialIds) ||
    goal.expected.material_count !== items.length ||
    goal.expected.pallet_count !== pallets.length ||
    task.pallet_count !== pallets.length ||
    task.material_count !== items.length ||
    task.max_items_per_pallet !==
      Math.max(...pallets.map((p) => p.items.length))
  ) {
    throw new Error(
      "Machining task and independent goal identities/counts differ",
    );
  }
  const departure = z
    .object({ ids: z.array(name), manifest: z.literal("pallets.items") })
    .parse(goal.all.find((g) => g.kind === "all_pallets_loaded_and_departed"));
  const processed = z
    .object({
      machine: name,
      point: name,
      items: z.array(z.object({ material: name, slot: name })),
    })
    .parse(goal.all.find((g) => g.kind === "processed_and_returned"));
  const deliverySlots = new Map(
    processed.items.map((i) => [i.material, i.slot]),
  );
  const sourceSlots = new Set(items.map((i) => i.source));
  if (
    !sameIds(departure.ids, palletIds) ||
    !sameIds(
      processed.items.map((i) => i.material),
      materialIds,
    ) ||
    new Set(deliverySlots.values()).size !== items.length ||
    sourceSlots.size !== items.length
  )
    throw new Error(
      "Machining return-slot or departure goal differs from production",
    );

  function onlyDevice(type: string) {
    const matches = [...devices.values()].filter(
      (d) => d.contract.device_type === type,
    );
    if (matches.length !== 1)
      throw new Error("Machining requires a single " + type);
    return matches[0];
  }
  const machine = onlyDevice("machine_tool"),
    robot = onlyDevice("robot_arm"),
    point = processed.point;
  if (
    processed.machine !== machine.instance_id ||
    Object.keys(machine.locations).length !== 1 ||
    machine.locations[point]?.frame !== "scene_world_m"
  )
    throw new Error("Machining point differs from the bound machine");
  const cycleSeconds = z
    .number()
    .finite()
    .positive()
    .parse(machine.parameters.cycle_time_s);
  const initial = z
    .object({
      existing_carrier: name,
      carrier_template: name,
      placement: z.literal("from_glb"),
    })
    .parse(bundle.initial);
  const env = bundle.environment ?? [];
  if (
    !sameIds(
      env.map((e) => String(e.kind)),
      ["finite_loaded_carrier_supply", "loaded_carrier_takeaway"],
    )
  )
    throw new Error(
      "Machining requires a finite loaded carrier supply and receiver",
    );
  const supply = z
    .object({ carrier_template: name, source_device: name, target: name })
    .parse(env.find((e) => e.kind === "finite_loaded_carrier_supply"));
  const exitTarget = name.parse(
    env.find((e) => e.kind === "loaded_carrier_takeaway")?.source,
  );
  const sourceDevice = supply.source_device;
  if (
    initial.existing_carrier !== pallets[0].id ||
    initial.carrier_template !== supply.carrier_template ||
    devices.get(sourceDevice)?.contract.device_type !==
      "material_source_station" ||
    devices.get(sourceDevice)?.parameters.product_spec !==
      supply.carrier_template
  )
    throw new Error("Invalid loaded-carrier source or first GLB inventory");

  const targets: MachiningConfig["targets"] = new Map();
  const owner = new Map<string, string>();
  for (const d of devices.values()) {
    if (d.contract.device_type !== "conveyor") continue;
    for (const [key, location] of Object.entries(d.locations)) {
      if (targets.has(key) || location.frame !== "scene_world_m")
        throw new Error("Invalid line target " + key);
      owner.set(key, d.instance_id);
      targets.set(key, {
        position: location.position,
        reference: location.reference ?? "carrier_origin",
        supportDevice: location.support_device ?? d.instance_id,
      });
    }
  }
  const entryDevice = owner.get(supply.target),
    exitDevice = owner.get(exitTarget);
  if (!entryDevice || !exitDevice || leaders.size !== 1)
    throw new Error("Invalid machining line endpoints");
  const [[leader, members]] = leaders;
  if (
    !members.includes(entryDevice) ||
    !members.includes(exitDevice) ||
    [...targets.values()].some((t) => !members.includes(t.supportDevice))
  )
    throw new Error("Machining transport target outside coupled drive");
  const transportTargets = new Set<string>();
  function resolveLineTargets(n: ProcessNode) {
    if (n.kind === "invoke" && n.behavior === "transport_to_position") {
      const expr = n.arguments.target;
      if (n.device.kind !== "ref" || n.device.name !== leader)
        throw new Error("Machining transport requires a bound mainline target");
      const key =
        expr?.kind === "field" && expr.base.kind === "ref"
          ? expr.base.name + "." + expr.field
          : expr?.kind === "literal" && typeof expr.value === "string"
            ? expr.value
            : undefined;
      if (!key || !targets.has(key))
        throw new Error("Missing machining line target " + key);
      transportTargets.add(key);
    }
    childrenOf(n).forEach(resolveLineTargets);
  }
  resolveLineTargets(root);
  if (!transportTargets.delete(exitTarget) || transportTargets.size !== 1)
    throw new Error("Machining requires one pallet station and one exit");
  const [stationTarget] = transportTargets;
  const runtimeSubjects = [...devices.values()].filter(
    (d) =>
      d.asset_kind === "runtime_material" || d.asset_kind === "runtime_carrier",
  );
  if (
    !sameIds(
      runtimeSubjects.map((d) => d.instance_id),
      [...palletIds, ...materialIds],
    )
  )
    throw new Error("Machining task and physical subjects differ");
  const subjectIds = new Map<string, number>(),
    used = new Set<number>();
  for (const d of runtimeSubjects) {
    const id = z.number().int().positive().max(2147483647).parse(d.subject_id);
    if (used.has(id)) throw new Error("Duplicate machining subject ID");
    subjectIds.set(d.instance_id, id);
    used.add(id);
  }
  const finishedByMaterial = new Map<string, SceneDevice>();
  const authored = new Map(bundle.devices.map((d) => [d.instance_id, d]));
  for (const [index, p] of pallets.entries()) {
    const carrier = devices.get(p.id)!;
    const policy = index === 0 ? "adopt_existing_glb" : "clone_on_admission";
    const inventory = z
      .object({ contents: z.array(name) })
      .parse(authored.get(p.id)?.initial_inventory);
    if (
      carrier.asset_kind !== "runtime_carrier" ||
      carrier.prototype_ref !== supply.carrier_template ||
      carrier.creation_policy !== policy ||
      !sameIds(
        inventory.contents,
        p.items.map((i) => i.material),
      )
    )
      throw new Error("Invalid initial machining inventory: " + p.id);
    for (const i of p.items) {
      const d = devices.get(i.material)!,
        l = carrier.locations[i.source];
      if (
        carrier.locations[deliverySlots.get(i.material)!]?.frame !==
          "carrier_local_m" ||
        carrier.locations[deliverySlots.get(i.material)!]?.owner !== p.id ||
        !l ||
        l.owner !== p.id ||
        l.frame !== "carrier_local_m" ||
        d.asset_kind !== "runtime_material" ||
        d.creation_policy !== policy ||
        authored.get(i.material)?.initial_support !== p.id
      )
        throw new Error(
          "Missing bound workpiece or original pallet slot: " + i.material,
        );
      const property = processingSpec.parse(
        d.contract.type_specific_contract,
      ).processing;
      const finished = devices.get(property.finished_template);
      if (
        !finished ||
        finished.asset_kind !== "material_prefab" ||
        finished.contract.device_type !== "workpiece" ||
        !finished.node_binding.owned_mesh_indices.length ||
        finished.instance_id === d.prototype_ref ||
        finished.geometry.bounds.size.some(
          (v, axis) => Math.abs(v - d.geometry.bounds.size[axis]) > 1e-4,
        )
      )
        throw new Error(
          "Finished model incompatible with shared workpiece collision envelope: " +
            i.material,
        );
      finishedByMaterial.set(i.material, finished);
    }
  }
  const machining: MachiningConfig = {
    machine: machine.instance_id,
    point,
    robot: robot.instance_id,
    leader,
    stationTarget,
    exitTarget,
    cycleTicks: Math.ceil(cycleSeconds * 60),
    deliverySlots,
    pallets,
    targets,
  };
  return {
    machining,
    task,
    subjectIds,
    sourceDevice,
    entryDevice,
    exitDevice,
    outfeeds: [exitDevice],
    goals: { ...goal.expected, deliveries: [] },
    finishedByMaterial,
  };
}

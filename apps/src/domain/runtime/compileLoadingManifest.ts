import { z } from "zod";
import type { SceneBundle } from "@/contracts/scene-package";
import { childrenOf, type ProcessNode } from "@/contracts/process-ir";
import type { LoadingConfig, SceneDevice } from "@/contracts/scene-execution";

/** The empty carrier, exchange and item targets are declared authoring data. */
export function isLoadingBundle(bundle: SceneBundle) {
  return bundle.devices.some(
    (d) =>
      d.asset_kind === "carrier_prefab" &&
      (d.prefab as { kind?: string } | undefined)?.kind === "empty_carrier",
  );
}

const name = z.string().min(1);
const palletSchema = z.object({
  id: name,
  prototype_ref: name,
  items: z
    .array(z.object({ material: name, category: name, target: name }))
    .min(1),
});
const taskSchema = z
  .object({
    pallets: z.array(palletSchema).min(1),
    pallet_count: z.number().int().positive(),
    material_count: z.number().int().positive(),
    jobs: z.array(z.unknown()).length(0),
    job_count: z.literal(0),
    max_items_per_pallet: z.number().int().positive(),
  })
  .passthrough();
const supplySchema = z.object({
  kind: z.literal("finite_material_supply"),
  source_device: name,
  target: name,
  material_template: name,
});
const exchangeSchema = z.object({
  kind: z.literal("external_pallet_exchange"),
  entry: name,
  source: name,
});
const goalSchema = z.object({
  scene_id: name,
  expected: z.object({
    pallet_count: z.number().int().positive(),
    material_count: z.number().int().positive(),
    material_ids: z.array(name),
    pallet_ids: z.array(name),
  }),
  all: z.array(z.record(z.string(), z.unknown())),
});
const requiredGoals = [
  "all_pallets_loaded_and_departed",
  "tools_empty",
  "drives_stopped",
  "no_active_requests",
  "no_pending_jobs",
  "operations_released",
];
const definitionVersions: Record<string, string> = {
  conveyor: "1.2.0",
  robot_arm: "1.0.0",
  material_source_station: "1.0.0",
  workpiece: "1.0.0",
  workpiece_carrier: "1.0.0",
};
const slotSchema = z.object({
  id: name,
  material_template: name,
  source_device: name,
  category: name,
});

function sameIds(a: readonly string[], b: readonly string[]) {
  const expected = new Set(b);
  return (
    a.length === b.length &&
    expected.size === b.length &&
    new Set(a).size === a.length &&
    a.every((x) => expected.has(x))
  );
}

function checkCalls(
  bundle: SceneBundle,
  root: ProcessNode,
  devices: Map<string, SceneDevice>,
) {
  const capabilities: Record<string, Set<string>> = {
    "conveyor@1.2.0": new Set([
      "transport_to_position",
      "release_material",
      "stop_conveying",
    ]),
    "robot_arm@1.0.0": new Set(["pick_and_place", "move_to_pose"]),
  };
  const catalog = new Map(bundle.calls.map((c) => [c.node, c]));
  let visited = 0;
  function check(n: ProcessNode) {
    if (n.kind === "invoke") {
      const c = catalog.get(n.id);
      const d = c && devices.get(c.device);
      if (
        !c ||
        c.experimental ||
        !d ||
        n.device.kind !== "ref" ||
        n.device.name !== c.device ||
        n.behavior !== c.behavior ||
        !capabilities[d.contract.device_type + "@" + d.contract.version]?.has(
          c.behavior,
        )
      )
        throw new Error("Unsupported/unbound loading action: " + n.id);
      visited++;
    }
    childrenOf(n).forEach(check);
  }
  check(root);
  if (visited !== bundle.calls.length)
    throw new Error("Loading call catalog differs from DSL");
}

export function compileLoadingManifest(
  bundle: SceneBundle,
  rawGoal: unknown,
  root: ProcessNode,
  devices: Map<string, SceneDevice>,
  leaders: Map<string, string[]>,
) {
  const task = taskSchema.parse(bundle.process.task),
    goal = goalSchema.parse(rawGoal);
  const pallets = task.pallets,
    palletIds = pallets.map((p) => p.id),
    materialIds = pallets.flatMap((p) => p.items.map((i) => i.material));
  if (
    goal.scene_id !== bundle.id ||
    !sameIds(palletIds, goal.expected.pallet_ids) ||
    !sameIds(materialIds, goal.expected.material_ids) ||
    goal.expected.pallet_count !== palletIds.length ||
    goal.expected.material_count !== materialIds.length ||
    task.pallet_count !== palletIds.length ||
    task.material_count !== materialIds.length ||
    task.max_items_per_pallet !==
      Math.max(...pallets.map((p) => p.items.length))
  )
    throw new Error(
      "Loading task and independent goal identities/counts differ",
    );
  if (
    !sameIds(
      goal.all.map((g) => String(g.kind)),
      requiredGoals,
    )
  )
    throw new Error("Unsupported or incomplete loading goal");
  const departure = z
    .object({ ids: z.array(name), manifest: z.literal("pallets.items") })
    .parse(goal.all.find((g) => g.kind === "all_pallets_loaded_and_departed"));
  if (!sameIds(departure.ids, palletIds))
    throw new Error("Loading departure identities differ");
  checkCalls(bundle, root, devices);
  for (const device of devices.values()) {
    const type = String(device.contract.device_type);
    if (
      !Object.hasOwn(definitionVersions, type) ||
      device.contract.version !== definitionVersions[type]
    )
      throw new Error(
        "Unsupported loading device contract: " + device.instance_id,
      );
  }
  const idsFor = (kind: string) =>
    [...devices.values()]
      .filter((d) => d.asset_kind === kind)
      .map((d) => d.instance_id);
  if (
    !sameIds(idsFor("runtime_carrier"), palletIds) ||
    !sameIds(idsFor("runtime_material"), materialIds)
  )
    throw new Error("Registered physical subjects differ from loading task");

  const targetOwners = new Map<string, string>(),
    targets: LoadingConfig["targets"] = new Map();
  const memberOwner = new Map(
    [...leaders].flatMap(([leader, members]) =>
      members.map((id) => [id, leader] as const),
    ),
  );
  for (const [id, d] of devices) {
    if (d.contract.device_type !== "conveyor") continue;
    for (const [key, loc] of Object.entries(d.locations)) {
      if (targetOwners.has(key) || loc.frame !== "scene_world_m")
        throw new Error("Invalid/duplicate loading line endpoint: " + key);
      const supportDevice = loc.support_device ?? id;
      if (
        !memberOwner.has(id) ||
        memberOwner.get(id) !== memberOwner.get(supportDevice)
      )
        throw new Error("Target support outside loading line: " + key);
      targetOwners.set(key, id);
      targets.set(key, {
        position: loc.position,
        reference: loc.reference ?? "carrier_origin",
        supportDevice,
      });
    }
  }
  const owner = (key: string) => {
    const id = targetOwners.get(key);
    if (!id) throw new Error("Unknown loading line endpoint: " + key);
    return id;
  };
  const env = bundle.environment ?? [],
    exchangeRecords = env.filter((e) => e.kind === "external_pallet_exchange");
  if (
    exchangeRecords.length !== 1 ||
    env.some(
      (e) =>
        !["finite_material_supply", "external_pallet_exchange"].includes(
          String(e.kind),
        ),
    )
  )
    throw new Error("Incomplete or unsupported loading environment");
  const ex = exchangeSchema.parse(exchangeRecords[0]),
    entryDevice = owner(ex.entry),
    exitDevice = owner(ex.source);
  const leader = memberOwner.get(entryDevice)!;
  if (leader !== memberOwner.get(exitDevice))
    throw new Error("Pallet exchange requires one mainline drive group");
  const exchange = { entry: ex.entry, exit: ex.source, leader };
  const supplies: LoadingConfig["supplies"] = env
    .filter((e) => e.kind === "finite_material_supply")
    .map((raw) => {
      const e = supplySchema.parse(raw),
        feeder = devices.get(e.source_device),
        entry = owner(e.target),
        leader = memberOwner.get(entry)!;
      if (
        feeder?.contract.device_type !== "material_source_station" ||
        feeder.parameters.product_spec !== e.material_template ||
        devices.get(e.material_template)?.asset_kind !== "material_prefab"
      )
        throw new Error(
          "Invalid material feeder or prototype: " + e.source_device,
        );
      return {
        device: e.source_device,
        materialTemplate: e.material_template,
        entry: e.target,
        entryDevice: entry,
        leader,
        materials: [],
      };
    });
  if (
    !supplies.length ||
    new Set(supplies.map((s) => s.device)).size !== supplies.length ||
    new Set([exchange.leader, ...supplies.map((s) => s.leader)]).size !==
      supplies.length + 1
  )
    throw new Error("Loading supply/group ownership is ambiguous");
  const byFeeder = new Map(supplies.map((s) => [s.device, s])),
    materialSupply = new Map<string, string>();
  const rawDevices = new Map(bundle.devices.map((d) => [d.instance_id, d])),
    subjectIds = new Map<string, number>(),
    usedSubjects = new Set<number>();
  function subject(id: string, kind: string) {
    const d = devices.get(id),
      sid = d?.subject_id;
    if (
      !d ||
      d.asset_kind !== kind ||
      typeof sid !== "number" ||
      !Number.isSafeInteger(sid) ||
      sid <= 0 ||
      sid > 2147483647 ||
      usedSubjects.has(sid)
    )
      throw new Error("Invalid loading subject identity: " + id);
    usedSubjects.add(sid);
    const prototype = devices.get(d.prototype_ref ?? "");
    if (
      !prototype ||
      d.contract.device_type !== prototype.contract.device_type ||
      !d.node_binding.owned_mesh_indices.length ||
      JSON.stringify(d.node_binding.owned_mesh_indices) !==
        JSON.stringify(prototype.node_binding.owned_mesh_indices)
    )
      throw new Error(
        "Loading instance mesh differs from its prototype: " + id,
      );
    subjectIds.set(id, sid);
    return d;
  }
  for (const p of pallets) {
    const carrier = subject(p.id, "runtime_carrier"),
      prototype = rawDevices.get(p.prototype_ref);
    if (
      carrier.prototype_ref !== p.prototype_ref ||
      prototype?.asset_kind !== "carrier_prefab"
    )
      throw new Error("Carrier prototype mismatch: " + p.id);
    z.object({ contents: z.array(z.unknown()).length(0) }).parse(
      rawDevices.get(p.id)?.initial_inventory,
    );
    const prefab = z
      .object({ kind: z.literal("empty_carrier"), slots: z.array(slotSchema) })
      .parse(prototype.prefab);
    const slots = new Map(prefab.slots.map((s) => [p.id + "." + s.id, s]));
    if (
      slots.size !== prefab.slots.length ||
      !sameIds(
        p.items.map((i) => i.target),
        [...slots.keys()],
      )
    )
      throw new Error("Empty-carrier target manifest differs: " + p.id);
    for (const item of p.items) {
      const m = subject(item.material, "runtime_material"),
        slot = slots.get(item.target)!,
        s = byFeeder.get(slot.source_device);
      if (
        carrier.locations[item.target]?.frame !== "carrier_local_m" ||
        slot.category !== item.category ||
        !s ||
        m.initial_supply !== s.device ||
        s.materialTemplate !== slot.material_template ||
        m.prototype_ref !== slot.material_template
      )
        throw new Error(
          "Invalid loading slot/material/supply mapping: " + item.material,
        );
      materialSupply.set(item.material, s.device);
      s.materials.push(item.material);
    }
  }
  const checkAdmissions = (ids: string[], first: string) => {
    if (
      ids.filter(
        (id) => devices.get(id)?.creation_policy === "adopt_existing_glb",
      ).length !== 1 ||
      ids.some(
        (id) =>
          devices.get(id)?.creation_policy !==
          (id === first ? "adopt_existing_glb" : "clone_on_admission"),
      )
    )
      throw new Error(
        "Invalid initial GLB inventory or future admission policy",
      );
  };
  const initial = z
    .object({
      existing_carrier: name,
      placement: z.literal("from_glb"),
      contents: z.array(z.unknown()).length(0),
    })
    .parse(bundle.initial);
  if (initial.existing_carrier !== palletIds[0])
    throw new Error("Initial empty carrier differs from first batch admission");
  checkAdmissions(palletIds, initial.existing_carrier);
  for (const s of supplies) checkAdmissions(s.materials, s.materials[0]);
  const owned = new Set<number>();
  for (const d of devices.values()) {
    if (
      d.asset_kind?.endsWith("_prefab") ||
      d.creation_policy === "clone_on_admission"
    )
      continue;
    for (const i of d.node_binding.owned_mesh_indices) {
      if (owned.has(i) || bundle.nodes[i]?.mesh == null)
        throw new Error("Invalid physical mesh ownership: " + d.instance_id);
      owned.add(i);
    }
  }
  const loading: LoadingConfig = {
    pallets,
    supplies,
    exchange,
    materialSupply,
    targets,
  };
  return {
    loading,
    task,
    subjectIds,
    entryDevice,
    exitDevice,
    sourceDevice: entryDevice,
    outfeeds: [exitDevice],
    goals: {
      material_ids: goal.expected.material_ids,
      pallet_ids: goal.expected.pallet_ids,
      deliveries: [],
    },
  };
}

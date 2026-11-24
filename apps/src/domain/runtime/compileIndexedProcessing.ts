import { PropertyBinding, Quaternion, Vector3 } from "three";
import { z } from "zod";
import { childrenOf, type ProcessNode } from "@/contracts/process-ir";
import type { IndexedProcessingConfig } from "@/contracts/indexed-processing";
import type { RuntimeBody, Vec3 } from "@/contracts/physics";
import type {
  CompiledSceneRuntime,
  SceneDevice,
} from "@/contracts/scene-execution";
import type { SceneBundle } from "@/contracts/scene-package";
import type { SceneGeometryReader } from "./SceneGeometryReader";

const name = z.string().min(1);
const vector = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const unit = vector.refine(
  (v) => Math.abs(Math.hypot(...v) - 1) < 1e-5,
  "Invalid interface/rotation axis",
);
const ports = z.array(
  z.object({
    interface_id: name,
    local_frame: z.object({ position: vector, forward: unit, up: unit }),
    capabilities: z.object({
      snap: z.object({ role: name, accepts: z.array(name) }),
    }),
  }),
);
function port(d: SceneDevice, role: string) {
  const roleOf = z.object({
    capabilities: z.object({ snap: z.object({ role: name }) }),
  });
  const declared = z.array(z.unknown()).parse(d.contract.interfaces);
  const found = ports.parse(
    declared.filter((p) => roleOf.parse(p).capabilities.snap.role === role),
  );
  if (
    found.length !== 1 ||
    Math.abs(
      new Vector3(...found[0].local_frame.forward).dot(
        new Vector3(...found[0].local_frame.up),
      ),
    ) > 1e-4
  )
    throw new Error(
      "Missing, ambiguous or invalid " +
        role +
        " interface on " +
        d.instance_id,
    );
  return found[0];
}
function interfacePosition(device: SceneDevice, p: ReturnType<typeof port>) {
  return new Vector3(...p.local_frame.position)
    .applyQuaternion(new Quaternion(...device.geometry.world_rotation))
    .add(new Vector3(...device.geometry.world_position));
}
function compatible(a: ReturnType<typeof port>, b: ReturnType<typeof port>) {
  return (
    a.capabilities.snap.accepts.includes(b.capabilities.snap.role) &&
    b.capabilities.snap.accepts.includes(a.capabilities.snap.role)
  );
}

/** Read a finite batch independently of its goal, and bind the moving geometry and tool interfaces. */
export function compileIndexedProcessing(
  bundle: SceneBundle,
  devices: Map<string, SceneDevice>,
  geometry: SceneGeometryReader,
  world: Pick<
    CompiledSceneRuntime,
    "physics" | "bodyMap" | "visualBodies" | "robots"
  >,
  goalInput: unknown,
  root: ProcessNode,
) {
  const task = z
    .object({
      jobs: z
        .array(
          z.object({
            id: name,
            material: name,
            input: name,
            target: name,
            prototype: name,
          }),
        )
        .min(1),
      pallets: z.array(z.never()).length(0),
      pallet_count: z.literal(0),
      material_count: z.number().int().positive(),
      job_count: z.number().int().positive(),
    })
    .passthrough()
    .parse(bundle.process.task);
  const ids = task.jobs.map((j) => j.material);
  const goal = z
    .object({
      scene_id: name,
      expected: z.object({
        material_ids: z.array(name),
        material_count: z.number(),
        pallet_ids: z.array(z.never()).length(0),
        pallet_count: z.literal(0),
      }),
      all: z.array(z.object({ kind: name }).passthrough()),
    })
    .parse(goalInput);
  const kinds = [
    "all_delivered_once",
    "required_operations",
    "tools_empty",
    "drives_stopped",
    "no_active_requests",
    "no_pending_jobs",
    "operations_released",
  ];
  if (
    goal.scene_id !== bundle.id ||
    task.job_count !== ids.length ||
    task.material_count !== ids.length ||
    new Set(ids).size !== ids.length ||
    new Set(task.jobs.map((j) => j.id)).size !== ids.length ||
    goal.expected.material_count !== ids.length ||
    JSON.stringify(ids) !== JSON.stringify(goal.expected.material_ids) ||
    goal.all.length !== kinds.length ||
    kinds.some((k) => goal.all.filter((g) => g.kind === k).length !== 1)
  )
    throw new Error("Indexed-processing goal or batch identities differ");
  const destinations = z
    .array(z.object({ material: name, target: name }))
    .parse(goal.all.find((g) => g.kind === "all_delivered_once")!.items);
  if (
    destinations.length !== ids.length ||
    task.jobs.some(
      (j) =>
        !destinations.some(
          (d) => d.material === j.material && d.target === j.target,
        ),
    )
  )
    throw new Error(
      "Indexed-processing delivery route differs from the independent goal",
    );
  const recipes = z
    .record(
      name,
      z.object({
        station: name,
        table: name,
        point: name,
        tool: name,
        interface: name,
      }),
    )
    .parse(goal.all.find((g) => g.kind === "required_operations")!.recipes);
  if (Object.keys(recipes).length !== 1)
    throw new Error("Expected one interface-bound processing recipe");
  const [[expectedRecipe, operation]] = Object.entries(recipes);

  const one = (type: string) => {
    const found = [...devices.values()].filter(
      (d) => d.contract.device_type === type,
    );
    if (found.length !== 1) throw new Error("Expected one " + type);
    return found[0];
  };
  const table = one("rotary_table"),
    human = one("human_operator"),
    robot = one("robot_arm"),
    source = one("material_source_station");
  const env = bundle.environment ?? [];
  const supply = z
    .object({ source_device: name, target: name, material_template: name })
    .parse(env.find((e) => e.kind === "finite_material_supply"));
  const takeaway = z
    .object({ sources: z.array(name).length(1) })
    .parse(env.find((e) => e.kind === "material_takeaway")).sources[0];
  const fixture = port(table, "fixture");
  const slot = table.instance_id + "." + fixture.interface_id;
  const prototype = devices.get(supply.material_template);
  const { recipe, interface: processInterface } = z
    .object({
      processing: z.object({ recipe: name, interface: name }),
    })
    .parse(prototype?.contract.type_specific_contract).processing;
  if (
    env.length !== 2 ||
    supply.source_device !== source.instance_id ||
    !source.locations[supply.target] ||
    !source.locations[takeaway] ||
    source.parameters.product_spec !== supply.material_template ||
    operation.station !== robot.instance_id ||
    operation.table !== table.instance_id ||
    Object.keys(table.locations).length !== 1 ||
    !table.locations[slot] ||
    operation.point !== slot ||
    expectedRecipe !== recipe ||
    operation.interface !== processInterface ||
    task.jobs.some(
      (j) =>
        j.prototype !== supply.material_template ||
        j.input !== supply.target ||
        j.target !== takeaway,
    )
  )
    throw new Error(
      "Indexed-processing resource or station binding differs from goal",
    );
  const angle = z.number().finite().min(0).lt(360);
  const { simulation, indexing_policy: policy } = z
    .object({
      indexing_policy: z.object({
        direction: z.literal("positive"),
        angle_reference: z.literal("normalized_degrees"),
        home_deg: angle,
        process_deg: angle,
        stations_deg: z.array(angle).min(1).optional(),
      }),
      simulation: z.object({
        rotor_node: name,
        support_node: name,
        axis_world: unit,
      }),
    })
    .parse(table.contract.type_specific_contract);
  const stations = policy.stations_deg ?? [
    ...new Set([policy.home_deg, policy.process_deg]),
  ];
  if (
    new Set(stations).size !== stations.length ||
    !stations.includes(policy.home_deg) ||
    !stations.includes(policy.process_deg)
  )
    throw new Error(
      "Load and processing docks must be configured indexing stations",
    );
  const supported = new Map([
    [human.instance_id, "carry_material"],
    [table.instance_id, "rotate_to_station"],
    [robot.instance_id, "process_material"],
  ]);
  const actions = new Map(bundle.calls.map((c) => [c.node, c]));
  const visited = new Set<string>();
  function visit(node: ProcessNode) {
    if (node.kind === "invoke") {
      const id = node.device.kind === "ref" ? node.device.name : undefined;
      const call = actions.get(node.id);
      if (
        !id ||
        supported.get(id) !== node.behavior ||
        call?.device !== id ||
        call.behavior !== node.behavior ||
        call.experimental ||
        visited.has(node.id)
      )
        throw new Error("Unbound indexed-processing call " + node.id);
      if (node.behavior === "rotate_to_station") {
        const expr = node.arguments.angleTag;
        if (
          expr?.kind === "quantity" &&
          expr.args[0]?.kind === "literal" &&
          (typeof expr.args[0].value !== "number" ||
            !stations.includes(expr.args[0].value))
        )
          throw new Error("Unknown indexing station at " + node.id);
      }
      visited.add(node.id);
    }
    childrenOf(node).forEach(visit);
  }
  visit(root);
  if (visited.size !== bundle.calls.length)
    throw new Error("Incomplete indexed-processing calls");

  const hand = z
    .object({
      simulation: z.object({
        hand_node: name,
        elbow_node: name,
        shoulder_node: name,
      }),
    })
    .parse(human.contract.type_specific_contract).simulation;
  // Node selectors use the same names as the catalog and GLTFLoader.
  function node(ref: string) {
    const matches = bundle.nodes.filter(
      (n) => n.name === ref || PropertyBinding.sanitizeNodeName(n.name) === ref,
    );
    if (matches.length !== 1)
      throw new Error("Missing or ambiguous GLB node " + ref);
    return matches[0].index;
  }
  function subtree(index: number, result = new Set<number>()) {
    if (result.has(index) || !bundle.nodes[index])
      throw new Error("Invalid GLB hierarchy");
    result.add(index);
    for (const child of bundle.nodes[index].children) subtree(child, result);
    return result;
  }
  function boundNodes(d: SceneDevice) {
    const root = bundle.devices.find(
      (raw) => raw.instance_id === d.instance_id,
    )!.node_binding.node_indices[0];
    return subtree(root);
  }
  const rotor = node(simulation.rotor_node),
    support = node(simulation.support_node),
    shoulder = node(hand.shoulder_node),
    elbow = node(hand.elbow_node),
    wrist = node(hand.hand_node);
  const moving = subtree(rotor);
  if (
    !boundNodes(table).has(rotor) ||
    !moving.has(support) ||
    !boundNodes(human).has(shoulder) ||
    !subtree(shoulder).has(elbow) ||
    !subtree(elbow).has(wrist)
  )
    throw new Error("Moving element or interface outside bound device");
  const meshes = table.node_binding.owned_mesh_indices.filter((i) =>
    moving.has(i),
  );
  if (!meshes.length || !meshes.includes(support))
    throw new Error("Rotor has no bound support mesh");
  const pivot = geometry.nodePose(rotor).position;
  const patch = geometry.convexParts([support], pivot);
  if (!patch.length) throw new Error("Table support geometry missing");
  const lo = new Vector3(Infinity, Infinity, Infinity),
    hi = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const hull of patch)
    for (const v of hull) {
      lo.min(new Vector3(...v));
      hi.max(new Vector3(...v));
    }
  const location = table.locations[slot];
  const handPort = port(human, "human_gripper");
  const handPosition = interfacePosition(human, handPort);
  const palmParts = geometry.convexParts(
    human.node_binding.owned_mesh_indices.filter((id) =>
      subtree(wrist).has(id),
    ),
    handPosition.toArray(),
  );
  const palmLo = new Vector3(Infinity, Infinity, Infinity),
    palmHi = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const hull of palmParts)
    for (const v of hull) {
      palmLo.min(new Vector3(...v));
      palmHi.max(new Vector3(...v));
    }
  if (
    !palmParts.length ||
    palmLo.toArray().some((n) => n > 0.002) ||
    palmHi.toArray().some((n) => n < -0.002) ||
    interfacePosition(table, fixture).distanceTo(
      new Vector3(...location.position),
    ) > 0.001
  )
    throw new Error("Gripper or fixture contract differs from bound geometry");
  const slotOffset = new Vector3(...location.position).sub(
    new Vector3(...pivot),
  );
  if (
    location.frame !== "scene_world_m" ||
    slotOffset.x < lo.x ||
    slotOffset.x > hi.x ||
    slotOffset.z < lo.z ||
    slotOffset.z > hi.z ||
    Math.abs(hi.y - slotOffset.y) > 0.003 ||
    Math.abs(simulation.axis_world[1] - 1) > 1e-5 ||
    Math.hypot(slotOffset.x, slotOffset.z) < 1e-4
  )
    throw new Error(
      "Indexed slot must reach two distinct sides on its horizontal support",
    );
  const tool = port(robot, "weld_tool");
  if (
    operation.tool !== tool.interface_id ||
    Math.hypot(...tool.local_frame.position) > 1e-6
  )
    throw new Error("Process tool interface must be bound to the declared TCP");
  // The TCP measures arc alignment. A solid gripper proxy at the wire tip would
  // push the supported workpiece away from the declared processing port.
  world.bodyMap.get(world.robots.get(robot.instance_id)!.toolBodyId)!.sensor =
    true;
  const config: IndexedProcessingConfig = {
    jobs: task.jobs,
    human: human.instance_id,
    table: table.instance_id,
    source: source.instance_id,
    robot: robot.instance_id,
    slot,
    indexing: { home: policy.home_deg, process: policy.process_deg, stations },
    pivot,
    axis: simulation.axis_world,
    slotOffset: slotOffset.toArray(),
    handBody: human.instance_id + "/hand",
    humanBody: human.instance_id + "/body",
    humanArm: { shoulder, elbow, wrist, palmHome: handPosition.toArray() },
    tableBody: table.instance_id + "/rotor",
    sourceBody: source.instance_id + "/support",
    materialFrames: new Map(),
    recipe,
    toolInterface: tool.interface_id,
    toolAxis: tool.local_frame.forward,
  };
  function add(body: RuntimeBody, visible: number[] = []) {
    if (world.bodyMap.has(body.id)) throw new Error("Duplicate indexed body");
    world.physics.bodies!.push(body);
    world.bodyMap.set(body.id, body);
    if (visible.length)
      world.visualBodies.push({
        bodyId: body.id,
        instanceId: body.instanceId,
        meshes: visible,
        initial: {
          position: body.position,
          rotation: body.rotation,
          velocity: [0, 0, 0],
        },
        future: false,
      });
  }
  const fixed = {
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    friction: 0.7,
    restitution: 0,
  };
  add(
    {
      ...fixed,
      id: config.tableBody,
      instanceId: config.table,
      motionType: "kinematic",
      role: "support",
      position: pivot,
      size: hi.clone().sub(lo).toArray(),
      convexParts: patch,
    },
    meshes,
  );
  for (const [id, position, visible] of [
    [
      config.humanBody,
      human.geometry.world_position,
      human.node_binding.owned_mesh_indices,
    ],
    [config.handBody, handPosition.toArray(), []],
  ] as const)
    add(
      {
        ...fixed,
        id,
        instanceId: config.human,
        motionType: "kinematic",
        role: "tool",
        sensor: true,
        size: [0.025, 0.025, 0.025],
        position,
      },
      [...visible],
    );
  const humanVisual = world.visualBodies.find(
    (b) => b.bodyId === config.humanBody,
  )!;
  humanVisual.rootNodeIndex = bundle.devices.find(
    (d) => d.instance_id === config.human,
  )!.node_binding.node_indices[0];
  const bounds = source.geometry.bounds;
  const center = bounds.min.map((v, i) => (v + bounds.max[i]) * 0.5) as Vec3;
  for (const point of [supply.target, takeaway]) {
    const loc = source.locations[point],
      p = loc.position;
    if (
      loc.frame !== "scene_world_m" ||
      Math.abs(p[1] - bounds.max[1]) > 0.005 ||
      p[0] < bounds.min[0] ||
      p[0] > bounds.max[0] ||
      p[2] < bounds.min[2] ||
      p[2] > bounds.max[2]
    )
      throw new Error("Source or takeaway is outside its support");
  }
  add({
    ...fixed,
    id: config.sourceBody,
    instanceId: config.source,
    motionType: "static",
    role: "support",
    position: center,
    size: bounds.size,
  });
  const subjectIds = new Map<string, number>();
  const runtimeMaterials = [...devices.values()].filter(
    (d) => d.asset_kind === "runtime_material",
  );
  if (runtimeMaterials.length !== ids.length)
    throw new Error("Unexpected indexed workpiece inventory");
  for (const [index, id] of ids.entries()) {
    const material = devices.get(id),
      body = world.bodyMap.get(id + "/body");
    if (
      !material ||
      material.asset_kind !== "runtime_material" ||
      material.prototype_ref !== supply.material_template ||
      material.creation_policy !==
        (index === 0 ? "adopt_existing_glb" : "clone_on_admission") ||
      !body ||
      material.subject_id !== index + 1
    )
      throw new Error("Unbound indexed material " + id);
    subjectIds.set(id, index + 1);
    const grasp = port(material, "grasp_target"),
      process = port(material, "process_target"),
      base = port(material, "workpiece");
    const state = z
      .object({
        processing: z.object({
          initial_state: z.literal("raw"),
          finished_state: z.literal("finished"),
          interface: name,
          recipe: name,
        }),
      })
      .parse(material.contract.type_specific_contract).processing;
    if (
      process.interface_id !== state.interface ||
      process.interface_id !== processInterface ||
      state.recipe !== recipe ||
      grasp.interface_id === process.interface_id ||
      !compatible(grasp, handPort) ||
      !compatible(base, fixture) ||
      !compatible(tool, process)
    )
      throw new Error(
        "Material processing/grasp interfaces differ from the tool or recipe",
      );
    const rest = new Quaternion(...material.geometry.world_rotation);
    const frame = (p: typeof tool) => {
      const offset = interfacePosition(material, p).sub(
        new Vector3(...body.position),
      );
      if (
        offset.toArray().some((v, i) => Math.abs(v) > body.size[i] / 2 + 0.005)
      )
        throw new Error("Material interface outside collision envelope");
      return {
        offset: offset.toArray(),
        outward: new Vector3(...p.local_frame.forward)
          .applyQuaternion(rest)
          .normalize()
          .toArray(),
      };
    };
    const seating = frame(base);
    if (
      new Vector3(...seating.offset).distanceTo(
        new Vector3(0, -body.size[1] / 2, 0),
      ) > 0.002 ||
      seating.outward[1] > -0.999
    )
      throw new Error(
        "Workpiece seating interface is not at the supported bottom center",
      );
    config.materialFrames.set(id, {
      grasp: frame(grasp),
      process: frame(process),
      graspInterface: grasp.interface_id,
      processInterface: process.interface_id,
    });
  }
  return {
    indexedProcessing: config,
    task,
    subjectIds,
    sourceDevice: config.source,
    entryDevice: config.table,
    exitDevice: config.source,
    outfeeds: [config.source],
    goals: {
      material_ids: ids,
      pallet_ids: [],
      deliveries: destinations.map((d) => ({ ...d, handler: config.human })),
    },
  };
}

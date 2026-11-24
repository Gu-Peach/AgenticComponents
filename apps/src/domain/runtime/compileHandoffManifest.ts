import { sceneGraspFrames, selectGraspFrame } from "./materialGraspFrames";
import { getDeviceModule, resolveDeviceAction } from "@/devices/registry";
import {
  bindFactRoles,
  compileSignalConnections,
  type StepFacts,
} from "./compileSignalConnections";
import { Quaternion, Vector3 } from "three";
import { z } from "zod";
import type { SceneBundle } from "@/contracts/scene-package";
import type { SceneDevice } from "@/contracts/scene-execution";
import {
  handoffCallBehavior,
  type HandoffConfig,
} from "@/contracts/robot-handoff";
import {
  childrenOf,
  type ProcessNode,
  type Expression,
} from "@/contracts/process-ir";

const name = z.string().min(1);
const vector = z.tuple([z.number(), z.number(), z.number()]);
const unitVector = vector.refine((v) => Math.abs(Math.hypot(...v) - 1) < 1e-6);
export const materialPose = z.object({
  orientation_quaternion: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .refine((q) => Math.abs(Math.hypot(...q) - 1) < 1e-5),
  contact_frame: name.optional(),
  reference: name.optional(),
});

export function compileHandoffManifest(
  bundle: SceneBundle,
  root: ProcessNode,
  devices: Map<string, SceneDevice>,
  rawGoal: unknown,
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
      material_count: z.number(),
      pallet_count: z.literal(0),
    })
    .passthrough()
    .parse(bundle.process.task);
  const goal = z
    .object({
      scene_id: name,
      expected: z.object({
        material_ids: z.array(name),
        material_count: z.number(),
        pallet_count: z.literal(0),
        pallet_ids: z.array(z.never()).length(0),
      }),
      all: z.array(z.object({ kind: name }).passthrough()),
    })
    .parse(rawGoal);
  const kinds = [
    "all_delivered_once",
    "tools_empty",
    "drives_stopped",
    "no_active_requests",
    "no_pending_jobs",
    "operations_released",
  ];
  const ids = task.jobs.map((j) => j.material);
  if (
    goal.scene_id !== bundle.id ||
    new Set(ids).size !== ids.length ||
    JSON.stringify(ids) !== JSON.stringify(goal.expected.material_ids) ||
    ids.length !== task.material_count ||
    ids.length !== goal.expected.material_count ||
    kinds.length !== goal.all.length ||
    kinds.some((k) => goal.all.filter((g) => g.kind === k).length !== 1)
  )
    throw new Error("Handoff goal or batch identities differ");
  const deliveryGoal = goal.all.find((g) => g.kind === "all_delivered_once")!;
  const deliveries = z
    .array(z.object({ material: name, target: name }))
    .parse(deliveryGoal.items);
  if (
    deliveries.length !== ids.length ||
    task.jobs.some(
      (j) =>
        !deliveries.some(
          (d) => d.material === j.material && d.target === j.target,
        ),
    )
  )
    throw new Error("Handoff delivery route differs from goal");
  const env = bundle.environment ?? [];
  const supply = z
    .object({ source_device: name, target: name, material_template: name })
    .parse(env.find((e) => e.kind === "finite_material_supply"));
  const end = z
    .object({ sources: z.array(name).length(1) })
    .parse(env.find((e) => e.kind === "material_takeaway")).sources[0];
  const owner = (l: string) =>
    [...devices.values()].find((d) => Object.hasOwn(d.locations, l));
  const infeed = owner(supply.target),
    outfeed = owner(end);
  if (
    devices.get(supply.source_device)?.contract.device_type !==
      "material_source_station" ||
    devices.get(supply.source_device)?.parameters.product_spec !==
      supply.material_template ||
    !infeed ||
    !outfeed ||
    infeed === outfeed ||
    infeed.contract.device_type !== "conveyor" ||
    outfeed.contract.device_type !== "conveyor" ||
    task.jobs.some(
      (j) =>
        j.input !== supply.target ||
        j.target !== end ||
        j.prototype !== supply.material_template,
    )
  )
    throw new Error("Handoff supply/exit routes differ");
  const poseGoal = z
    .object({
      device: name,
      material_axis_local: unitVector,
      required_axis_world: unitVector,
      contact_frame: name,
    })
    .parse(deliveryGoal.required_transport_pose);
  const transportPolicy = z.object({
    reference_frame: z.literal("scene_world_m"),
    material_axis_local: unitVector,
    required_axis_world: unitVector,
    contact_frame: name,
    verify_throughout: z.literal(true),
    loss_policy: z.literal("controlled_stop"),
    max_tilt_deg: z.number().positive().lt(90),
  });
  const posePolicy = z
    .object({ transport_pose: transportPolicy })
    .parse(outfeed.contract.type_specific_contract).transport_pose;
  const materialAxis = new Vector3(...poseGoal.material_axis_local);
  const outfeedAxis = new Vector3(...poseGoal.required_axis_world);
  if (
    poseGoal.device !== outfeed.instance_id ||
    !materialAxis.equals(new Vector3(...posePolicy.material_axis_local)) ||
    !outfeedAxis.equals(new Vector3(...posePolicy.required_axis_world)) ||
    poseGoal.contact_frame !== posePolicy.contact_frame
  )
    throw new Error("Transport pose differs from the independent goal");
  const calls: Extract<ProcessNode, { kind: "invoke" }>[] = [];
  const jobBinding = new Map<string, string>();
  const visit = (n: ProcessNode, boundJob?: string) => {
    if (
      n.kind === "repeat" &&
      "over" in n &&
      n.over.kind === "field" &&
      n.over.base.kind === "ref" &&
      n.over.base.name === "task" &&
      n.over.field === "jobs"
    )
      boundJob = n.bind;
    if (n.kind === "invoke") {
      calls.push(n);
      if (boundJob) jobBinding.set(n.id, boundJob);
    }
    childrenOf(n).forEach((child) => visit(child, boundJob));
  };
  visit(root);
  const actionModes = new Map<string, string>();
  for (const call of calls) {
    if (call.device.kind !== "ref")
      throw new Error("Handoff requires a named device");
    const id = call.device.name,
      mode = handoffCallBehavior(call);
    const key = id + "." + call.behavior,
      previous = actionModes.get(key);
    if (previous && previous !== mode)
      throw new Error("Ambiguous handoff payload mode for " + key);
    if (mode !== call.behavior) {
      const record = z
        .object({
          fields: z.record(z.string(), z.string()),
        })
        .parse(
          (
            devices.get(id)?.contract.runtime_execution_contract as
              | {
                  payload_templates?: Record<string, unknown>;
                }
              | undefined
          )?.payload_templates?.[mode],
        );
      if (
        call.payload?.kind !== "payload" ||
        Object.keys(record.fields).length !==
          Object.keys(call.payload.kwargs).length ||
        Object.keys(call.payload.kwargs).some(
          (field) => !Object.hasOwn(record.fields, field),
        )
      )
        throw new Error(
          "Pick/place payload fields differ from the selected handoff contract",
        );
    }
    actionModes.set(key, mode);
  }
  const pick = calls.filter(
    (call) => handoffCallBehavior(call) === "pick_and_handoff",
  );
  const place = calls.filter(
    (call) => handoffCallBehavior(call) === "place_held_material",
  );
  if (
    pick.length !== 1 ||
    place.length !== 1 ||
    pick[0].device.kind !== "ref" ||
    place[0].device.kind !== "ref"
  )
    throw new Error("Handoff requires a giver and receiver");
  const giver = pick[0].device.name,
    receiver = place[0].device.name;
  // These endpoints belong to this DSL call; resolve their owners and point references at compile time.
  function endpoint(call: (typeof calls)[number], field: string) {
    const expr = call.payload?.kind === "payload" && call.payload.kwargs[field];
    if (expr && expr.kind === "literal" && typeof expr.value === "string")
      return expr.value;
    if (
      expr &&
      expr.kind === "field" &&
      expr.base.kind === "ref" &&
      devices.has(expr.base.name)
    )
      return expr.base.name + "." + expr.field;
    throw new Error("Unresolved transfer endpoint: " + call.id + "." + field);
  }
  const pickup = endpoint(pick[0], "source"),
    rendezvous = endpoint(pick[0], "target"),
    placement = endpoint(place[0], "target");
  if (
    owner(pickup) !== infeed ||
    owner(placement) !== outfeed ||
    owner(rendezvous)?.instance_id !== giver ||
    owner(rendezvous)?.locations[rendezvous].material_pose?.reference !==
      "grasp_frame_midpoint" ||
    giver === receiver
  )
    throw new Error("Invalid transfer endpoints or receiving device");
  const incoming = materialPose.parse(
    infeed.locations[pickup]?.material_pose ??
      infeed.locations[supply.target]?.material_pose,
  );
  if (!incoming.contact_frame)
    throw new Error("Incoming conveyor requires a material support frame");
  for (const key of [placement, end]) {
    const pose = outfeed.locations[key]?.material_pose;
    if (
      pose?.contact_frame !== posePolicy.contact_frame ||
      materialAxis
        .clone()
        .applyQuaternion(new Quaternion(...pose.orientation_quaternion))
        .dot(outfeedAxis) < 0.999
    )
      throw new Error(
        "Conveyor endpoint differs from its declared transport pose: " + key,
      );
  }
  const sourcePolicy = z
    .object({ transport_pose: transportPolicy.optional() })
    .parse(infeed.contract.type_specific_contract).transport_pose;
  // Historical input belts declare their support face and orientation only at the supply endpoint.
  const incomingAxis: [number, number, number] =
    sourcePolicy?.material_axis_local ?? [0, 1, 0];
  const incomingWorld = new Vector3(...incomingAxis).applyQuaternion(
    new Quaternion(...incoming.orientation_quaternion),
  );
  if (
    sourcePolicy &&
    (sourcePolicy.contact_frame !== incoming.contact_frame ||
      incomingWorld.dot(new Vector3(...sourcePolicy.required_axis_world)) <
        0.999)
  )
    throw new Error("Incoming endpoint differs from its transport pose");
  const maxTiltRad = (posePolicy.max_tilt_deg * Math.PI) / 180;
  const armPorts: Readonly<Record<string, unknown>> =
    getDeviceModule("robot_arm").contract.runtime_execution_contract
      .semantic_ports;
  const beltPorts: Readonly<Record<string, unknown>> =
    getDeviceModule("conveyor").contract.runtime_execution_contract
      .semantic_ports;
  const connections = new Map(
    task.jobs.map((job) => {
      const steps = new Map<string, StepFacts>();
      for (const call of calls) {
        if (call.device.kind !== "ref")
          throw new Error("Expected a named device");
        const self = call.device.name,
          mode = handoffCallBehavior(call);
        const role = (e: Expression | undefined): string | undefined => {
          if (!e) return;
          if (e.kind === "literal" && typeof e.value === "string")
            return e.value;
          if (e.kind === "ref" && devices.has(e.name)) return e.name;
          if (e.kind === "field" && e.base.kind === "ref") {
            if (e.base.name === jobBinding.get(call.id)) {
              if (
                e.field === "material" ||
                e.field === "input" ||
                e.field === "target" ||
                e.field === "id"
              )
                return job[e.field];
            } else if (
              devices.get(e.base.name)?.locations[e.base.name + "." + e.field]
            )
              return e.base.name + "." + e.field;
          }
          throw new Error("Unknown semantic fact role in " + call.id);
        };
        const payload =
          call.payload?.kind === "payload" ? call.payload.kwargs : {};
        const subject = call.arguments.subject_id;
        const material =
          subject?.kind === "subject_id"
            ? role(subject.args[0])
            : subject?.kind === "literal" && typeof subject.value === "number"
              ? ids[subject.value - 1]
              : role(payload.material);
        if (material !== undefined && material !== job.material)
          throw new Error("Material role differs from indexed job: " + call.id);
        const roles: Record<string, string> = {
          self,
          exit: self === infeed.instance_id ? pickup : end,
        };
        if (material) roles.material = material;
        for (const [name, e] of Object.entries({
          source: payload.source,
          target: payload.target ?? call.arguments.target,
          receiver: payload.receiver,
        })) {
          const v = role(e);
          if (v) roles[name] = v;
        }
        const ports =
          devices.get(self)?.contract.device_type === "robot_arm"
            ? armPorts
            : beltPorts;
        steps.set(call.id, bindFactRoles(ports[mode], roles));
      }
      return [job.material, compileSignalConnections(root, steps)] as const;
    }),
  );
  const handoff: HandoffConfig = {
    actionModes,
    connections,
    jobs: task.jobs,
    source: supply.source_device,
    infeed: infeed.instance_id,
    outfeed: outfeed.instance_id,
    giver,
    receiver,
    rendezvous,
    pickup,
    placement,
    delivery: end,
    transportPoses: new Map([
      [
        infeed.instance_id,
        {
          contactFrame: incoming.contact_frame,
          axisLocal: incomingAxis,
          axisWorld: incomingWorld.toArray(),
          maxTiltRad: ((sourcePolicy?.max_tilt_deg ?? 10) * Math.PI) / 180,
        },
      ],
      [
        outfeed.instance_id,
        {
          contactFrame: posePolicy.contact_frame,
          axisLocal: posePolicy.material_axis_local,
          axisWorld: posePolicy.required_axis_world,
          maxTiltRad,
        },
      ],
    ]),
    materialFrames: new Map(),
    approachAxes: new Map(),
  };
  const subjectIds = new Map<string, number>();
  for (const [i, id] of ids.entries()) {
    const device = devices.get(id);
    if (
      !device ||
      (device.initial_supply && device.initial_supply !== handoff.source) ||
      device.prototype_ref !== supply.material_template ||
      device.asset_kind !== "runtime_material" ||
      device.subject_id !== i + 1
    )
      throw new Error("Handoff body does not match task: " + id);
    if (
      device.creation_policy !==
      (i === 0 ? "adopt_existing_glb" : "clone_on_admission")
    )
      throw new Error("Unexpected material admission policy");
    const frames = sceneGraspFrames(device);
    for (const policy of handoff.transportPoses.values())
      selectGraspFrame(frames, policy.contactFrame);
    for (const call of [...pick, ...place]) {
      if (call.payload?.kind !== "payload")
        throw new Error("Missing robot payload");
      for (const key of call === pick[0]
        ? ["giver_grasp", "receiver_grasp"]
        : ["grasp"]) {
        const e = call.payload.kwargs[key];
        if (e?.kind === "literal" && typeof e.value === "string")
          selectGraspFrame(frames, e.value);
      }
    }
    handoff.materialFrames.set(id, frames);
    subjectIds.set(id, i + 1);
  }
  for (const id of [giver, receiver]) {
    const device = devices.get(id);
    if (device?.contract.device_type !== "robot_arm") throw new Error("Unsupported transfer device: " + id);
    resolveDeviceAction(device.contract, id === giver ? "pick_and_handoff" : "place_held_material");
    const axis = z
      .object({ tooling: z.object({ approach_axis_local: vector }) })
      .parse(device.contract.type_specific_contract)
      .tooling.approach_axis_local;
    if (Math.abs(Math.hypot(...axis) - 1) > 1e-6)
      throw new Error("Invalid tool approach axis");
    handoff.approachAxes.set(id, axis);
  }
  return {
    handoff,
    task,
    subjectIds,
    sourceDevice: handoff.source,
    entryDevice: handoff.infeed,
    exitDevice: handoff.outfeed,
    outfeeds: [handoff.outfeed],
    goals: { material_ids: ids, pallet_ids: [], deliveries: [] },
  };
}

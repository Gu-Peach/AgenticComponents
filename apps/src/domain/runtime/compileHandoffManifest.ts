import { Quaternion, Vector3 } from "three";
import { z } from "zod";
import type { SceneBundle } from "@/contracts/scene-package";
import type { SceneDevice, Vec3 } from "@/contracts/scene-execution";
import type { HandoffConfig } from "@/contracts/robot-handoff";
import { childrenOf, type ProcessNode } from "@/contracts/process-ir";

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
    outfeed.instance_id + ".exit" !== end ||
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
      contact_frame: z.literal("head"),
    })
    .parse(deliveryGoal.required_transport_pose);
  const posePolicy = z
    .object({
      transport_pose: z.object({
        reference_frame: z.literal("scene_world_m"),
        material_axis_local: unitVector,
        required_axis_world: unitVector,
        contact_frame: z.literal("head"),
        verify_throughout: z.literal(true),
        loss_policy: z.literal("controlled_stop"),
        max_tilt_deg: z.number().positive().max(10),
      }),
    })
    .parse(outfeed.contract.type_specific_contract).transport_pose;
  const materialAxis = new Vector3(...poseGoal.material_axis_local);
  const outfeedAxis = new Vector3(...poseGoal.required_axis_world);
  if (
    poseGoal.device !== outfeed.instance_id ||
    !materialAxis.equals(new Vector3(...posePolicy.material_axis_local)) ||
    !outfeedAxis.equals(new Vector3(...posePolicy.required_axis_world)) ||
    outfeedAxis.y > -0.999
  )
    throw new Error(
      "Inverted transport pose differs from the independent goal",
    );
  for (const key of [outfeed.instance_id + ".entry", end]) {
    const pose = outfeed.locations[key]?.material_pose;
    if (
      pose?.contact_frame !== "head" ||
      materialAxis
        .clone()
        .applyQuaternion(new Quaternion(...pose.orientation_quaternion))
        .dot(outfeedAxis) < 0.999
    )
      throw new Error("Missing head-down endpoint: " + key);
  }
  const calls: Extract<ProcessNode, { kind: "invoke" }>[] = [];
  const visit = (n: ProcessNode) => {
    if (n.kind === "invoke") calls.push(n);
    childrenOf(n).forEach(visit);
  };
  visit(root);
  const pick = calls.filter((c) => c.behavior === "pick_and_handoff");
  const place = calls.filter((c) => c.behavior === "place_held_material");
  if (
    pick.length !== 1 ||
    place.length !== 1 ||
    pick[0].device.kind !== "ref" ||
    place[0].device.kind !== "ref"
  )
    throw new Error("Handoff requires a giver and receiver");
  const giver = pick[0].device.name,
    receiver = place[0].device.name;
  const rendezvous = Object.keys(devices.get(giver)?.locations ?? {}).find(
    (l) =>
      devices.get(giver)!.locations[l].material_pose?.reference ===
      "grasp_frame_midpoint",
  );
  if (!rendezvous || giver === receiver)
    throw new Error("Handoff midpoint is missing");
  const handoff: HandoffConfig = {
    jobs: task.jobs,
    source: supply.source_device,
    infeed: infeed.instance_id,
    outfeed: outfeed.instance_id,
    giver,
    receiver,
    rendezvous,
    outfeedAxis: outfeedAxis.toArray(),
    maxTiltRad: (posePolicy.max_tilt_deg * Math.PI) / 180,
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
      throw new Error("Handoff scene must admit one bottle at a time");
    const { geometry } = device;
    const center = geometry.bounds.min.map(
      (v, j) => (v + geometry.bounds.max[j]) / 2,
    ) as Vec3;
    const rest = new Quaternion(...geometry.world_rotation);
    const frames = z
      .object({
        grasping: z.object({
          frame_source: z.literal("material_local_m"),
          frames: z.record(
            name,
            z.object({ position_m: vector, approach_axis: unitVector }),
          ),
        }),
      })
      .parse(device.contract.type_specific_contract).grasping.frames;
    const points = Object.fromEntries(
      Object.entries(frames).map(([key, f]) => [
        key,
        {
          offset: new Vector3(...f.position_m)
            .applyQuaternion(rest)
            .add(new Vector3(...geometry.world_position))
            .sub(new Vector3(...center))
            .toArray(),
          outward: new Vector3(...f.approach_axis)
            .negate()
            .applyQuaternion(rest)
            .normalize()
            .toArray(),
        },
      ]),
    );
    if (
      !points.head ||
      !points.tail ||
      materialAxis
        .clone()
        .applyQuaternion(rest)
        .dot(new Vector3(...points.head.outward)) < 0.999 ||
      new Vector3(...points.head.outward).dot(
        new Vector3(...points.tail.outward),
      ) > -0.999
    )
      throw new Error("Opposed bottle grasp frames required");
    handoff.materialFrames.set(id, { rest: geometry.world_rotation, points });
    subjectIds.set(id, i + 1);
  }
  for (const id of [giver, receiver]) {
    const device = devices.get(id);
    if (
      device?.contract.device_type !== "robot_arm" ||
      device.contract.version !== "1.1.0"
    )
      throw new Error("Unsupported handoff arm");
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

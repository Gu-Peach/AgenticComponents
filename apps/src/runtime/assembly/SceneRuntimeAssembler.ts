import { Quaternion, Vector3 } from "three";
import { assembleWarehouseRuntime } from "./WarehouseRuntimeAssembler";
import { assembleLoadingRuntime } from "./LoadingRuntimeAssembler";
import { assembleHandoffRuntime } from "./HandoffRuntimeAssembler";
import type { CompiledSceneRuntime, Vec3 } from "@/contracts/scene-execution";
import type { ActionRequest, ActionBinding } from "@/contracts/scheduler";
import type {
  ConditionContext,
  ObservationDefinition,
  ObservationWrite,
  Truth,
} from "@/contracts/conditions";
import type { BodyPose } from "@/contracts/physics";
import type { RobotStep } from "@/contracts/robot-command";
import { createJoltBackend } from "@/runtime/physics/jolt/JoltPhysicsBackend";
import {
  PositionTransportAdapter,
  type PositionTransportConfig,
  type TransportTarget,
} from "@/runtime/adapters/scene/PositionTransportAdapter";
import { RobotSceneAdapter } from "@/runtime/adapters/scene/RobotSceneAdapter";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import {
  FiniteSceneEnvironment,
  type CarrierLoad,
  type HandoffTarget,
} from "@/runtime/services/FiniteSceneEnvironment";
import {
  ConditionProviders,
  SignalRegistry,
  ObservationRegistry,
} from "@/runtime/signals";
import {
  bindDeviceBehavior,
  signalLayoutFromContract,
} from "@/domain/runtime/bindDeviceBehavior";
import { bindProcess } from "@/domain/runtime/bindProcess";
import { SceneRuntimeProgram } from "@/runtime/engine/SceneRuntimeProgram";
import { RuntimeFactoryRegistry } from "./RuntimeFactoryRegistry";
import { compileConditions } from "@/domain/runtime/compileConditions";
import { ConditionTrace } from "@/runtime/signals/ConditionTrace";
import {
  sceneConditionReader,
  sceneConditionProviderIds,
  supportsSceneConditionBinding,
} from "./SceneConditionBindings";
import type { ConditionDiagnostics } from "@/contracts/condition-expression";

interface BodyObservation {
  active: boolean;
  pose?: BodyPose;
  supports: string[];
  held: boolean;
}
interface WorldObservation {
  bodies: Record<string, BodyObservation>;
  receipts: ReturnType<FiniteSceneEnvironment["snapshot"]>;
  robotClear: Record<string, boolean>;
  deliveries: Record<
    string,
    { handler: string; receiver: string; target: string }
  >;
}
interface BehaviorDescription {
  behavior_id: string;
  arguments_schema: Record<string, unknown>;
  condition_contract: {
    preconditions: { key: string; source: string }[];
    sustaining_conditions: { key: string }[];
  };
  completion_contract: { checks: { key: string }[] };
}
export interface AssembledScene {
  program: SceneRuntimeProgram;
  compiled: CompiledSceneRuntime;
}

export async function assembleSceneRuntime(
  sceneId: string,
  runId: string,
  compiled: CompiledSceneRuntime,
  options: { conditionMode?: ConditionDiagnostics["mode"] } = {},
): Promise<AssembledScene> {
  if (compiled.warehouse)
    return assembleWarehouseRuntime(sceneId, runId, compiled);
  if (compiled.loading || compiled.machining)
    return assembleLoadingRuntime(sceneId, runId, compiled);
  if (compiled.handoff) return assembleHandoffRuntime(sceneId, runId, compiled);
  const conditionMode = options.conditionMode ?? "expression";
  const drivers: DeviceActionPort[] = [],
    providers = new ConditionProviders(new ConditionTrace(conditionMode)),
    observations: ObservationDefinition[] = [];
  const positionConfigs = new Map<string, PositionTransportConfig>();
  const positionDrivers = new Map<string, PositionTransportAdapter>();
  const robotDrivers = new Map<string, RobotSceneAdapter>();
  const robotHandoffs = new Map<
      string,
      { handler: string; receiver: string }
    >(),
    actualDeliveries: WorldObservation["deliveries"] = {};
  const definitions = [...compiled.devices.values()]
    .filter((d) => !d.asset_kind?.endsWith("_prefab"))
    .flatMap((d) =>
      signalLayoutFromContract(sceneId, d.instance_id, d.contract),
    );
  const signals = new SignalRegistry(runId, definitions);
  const bindings: ActionBinding[] = [];
  const requests = new Map<string, ActionRequest>();
  const body = (id: string) => {
    const b = compiled.bodyMap.get(id + "/body");
    if (!b) throw new Error("Missing subject body: " + id);
    return b;
  };
  const device = (id: string) => {
    const d = compiled.devices.get(id);
    if (!d) throw new Error("Unknown device " + id);
    return d;
  };
  const owner = (location: string) => {
    const d = [...compiled.devices.values()].find((d) =>
      Object.hasOwn(d.locations, location),
    );
    if (!d) throw new Error("Missing location " + location);
    return d;
  };
  const location = (key: string) => owner(key).locations[key].position;
  const reference = (id: string): Vec3 => {
    const d = device(id),
      b = body(id);
    return d.geometry.world_position.map((v, i) => v - b.position[i]) as Vec3;
  };
  const world = (c: ConditionContext) => {
    const s = c.observations?.samples["world/state"];
    return s?.quality === "good" && s.runId === runId
      ? (s.value as WorldObservation)
      : undefined;
  };
  const fields = (c: ConditionContext) =>
    (c.scope.payload as { fields?: Record<string, unknown> } | undefined)
      ?.fields ?? {};
  const args = (c: ConditionContext) =>
    c.scope.arguments as Record<string, unknown>;
  const subjects = new Map(
    [...compiled.subjectIds].map(([id, index]) => [
      index,
      { id, bodyId: body(id).id, referenceOffset: reference(id) },
    ]),
  );
  const supportBody = (surface: string) => {
    const s = compiled.physics.surfaces!.find(
      (s) => s.id === surface || s.aliases?.includes(surface),
    );
    if (!s) throw new Error("Missing support surface: " + surface);
    return compiled.bodyMap.get(s.bodyId)!;
  };
  const surface = (id: string) => id + "/surface";
  const allSupports = [
    ...compiled.physics.surfaces!.flatMap((s) => [s.id, ...(s.aliases ?? [])]),
    ...compiled.task.pallets.map((p) => body(p.id).id),
  ];
  const envBody = (id: string) => {
    const b = body(id);
    return {
      id,
      bodyId: b.id,
      size: b.size,
      initial: {
        position: b.position,
        rotation: b.rotation,
        velocity: [0, 0, 0] as Vec3,
      },
    };
  };
  const loads: CarrierLoad[] = compiled.task.pallets.map((p) => ({
    carrier: envBody(p.id),
    items: p.items.map((i) => envBody(i.material)),
    sourceSupport: surface(compiled.sourceDevice),
  }));
  const physics = await createJoltBackend(compiled.physics);
  try {
    const environment = new FiniteSceneEnvironment(runId, physics, loads);
    const pointFor = (id: string, target: string): TransportTarget => {
      const d = device(id),
        flow = (
          d.contract.type_specific_contract as { surface: { flow_axis: Vec3 } }
        ).surface.flow_axis;
      const nominal = target.startsWith("scene.")
        ? compiled.bundle.sorting_station!.position_m
        : location(target);
      const p = [...nominal] as Vec3;
      // Named entry/exit ports are support boundaries. Stop the leading edge inside the support.
      if (!target.startsWith("scene.")) {
        const half = Math.max(
          ...[...subjects.values()]
            .filter((s) =>
              (compiled.leaders.get(id)?.length ?? 0) > 1
                ? device(s.id).contract.device_type === "workpiece_carrier"
                : device(s.id).contract.device_type === "workpiece",
            )
            .map((s) => Math.hypot(...body(s.id).size) / 2),
        );
        p[0] -= flow[0] * (half + 0.025);
      }
      return {
        id: target,
        index: 1,
        position: p,
        supportIds: [surface(id)],
        ...(compiled.leaders.get(id)?.length === 1
          ? { heightMode: "preserve_supported" as const }
          : {}),
      };
    };
    const handoff = (
      subject: string,
      target: TransportTarget,
    ): HandoffTarget => ({
      position: target.position,
      referenceOffset:
        device(subject).contract.device_type === "workpiece"
          ? [0, 0, 0]
          : reference(subject),
      supportId: target.supportIds[0],
      tolerance: 0.035,
      speedTolerance: 0.03,
    });
    const factories = new RuntimeFactoryRegistry<string, DeviceActionPort>();
    factories.register("conveyor@1.2.0", (id) => {
      const d = device(id),
        members = compiled.leaders.get(id) ?? [id],
        group = members.length > 1;
      const selected = new Map(
        [...subjects]
          .filter(
            ([, s]) =>
              device(s.id).contract.device_type ===
              (group ? "workpiece_carrier" : "workpiece"),
          )
          .map(([key, value]) => [
            key,
            group ? value : { ...value, referenceOffset: [0, 0, 0] as Vec3 },
          ]),
      );
      const targets = [pointFor(id, id + ".exit")];
      if (compiled.bundle.sorting_station?.support_device === id)
        targets.push(
          pointFor(id, "scene." + compiled.bundle.sorting_station.id),
        );
      targets.forEach((t, i) => (t.index = i + 1));
      const speed = Number(d.parameters.speed_mps),
        accel = Number(d.parameters.accel_time_s),
        decel = Number(d.parameters.decel_time_s);
      if (accel <= 0 || decel <= 0)
        throw new Error("Finite scene transport requires positive ramp times");
      for (const member of members)
        if (
          Number(device(member).parameters.speed_mps) !== speed ||
          Number(device(member).parameters.accel_time_s) !== accel ||
          Number(device(member).parameters.decel_time_s) !== decel
        )
          throw new Error("Coupled drive ramp profiles disagree");
      const config: PositionTransportConfig = {
        publishDriveState: true,
        sceneId,
        runId,
        leader: id,
        drives: members.map((m) => ({
          device: m,
          surfaceId: surface(m),
          flow: (
            device(m).contract.type_specific_contract as {
              surface: { flow_axis: Vec3 };
            }
          ).surface.flow_axis,
        })),
        subjects: selected,
        targets,
        admissionSupportIds: group ? [surface(compiled.sourceDevice)] : [],
        maxSpeed: speed,
        acceleration: speed / accel,
        deceleration: speed / decel,
        positionTolerance: 0.025,
        speedTolerance: 0.02,
        verticalTolerance: 0.05,
        settleTicks: 3,
      };
      const hasPort = (port: string, direction: "input" | "output") =>
        definitions.some(
          (p) =>
            p.key === `${sceneId}/${id}/${port}` &&
            p.type === "BOOL" &&
            p.direction === direction,
        );
      if (hasPort("release_waiting_material", "input"))
        config.releasePermissionPort = "release_waiting_material";
      if (
        hasPort("part_ready", "output") &&
        hasPort("capacity_available", "output")
      ) {
        const capacity = Number(d.parameters.capacity);
        if (!Number.isSafeInteger(capacity) || capacity < 1)
          throw new Error("Invalid conveyor capacity");
        config.inventoryFeedback = {
          partReadyPort: "part_ready",
          capacityPort: "capacity_available",
          capacity,
        };
      }
      positionConfigs.set(id, config);
      const adapter = new PositionTransportAdapter(
        config,
        physics,
        (load, target, tick) => {
          const accepted = environment.deliverMaterial(
            load.id,
            handoff(load.id, target),
            tick,
          );
          if (accepted) {
            const robot = robotHandoffs.get(load.id);
            if (!robot || robot.receiver !== id)
              throw new Error("Output has no matching robot handoff");
            actualDeliveries[load.id] = {
              handler: robot.handler,
              receiver: id,
              target: target.id,
            };
          }
          return accepted;
        },
      );
      positionDrivers.set(id, adapter);
      return adapter;
    });
    factories.register("robot_arm@1.0.0", (id) => {
      const base = compiled.robots.get(id)!;
      const adapter = new RobotSceneAdapter(
        sceneId,
        runId,
        base,
        physics,
        (request) => {
          const p = (request.payload as { fields: Record<string, string> })
            .fields;
          if (!p) throw new Error("Robot payload fields missing");
          if (request.behavior === "move_to_pose")
            return {
              scene: base,
              steps: [
                {
                  kind: "move_to_pose",
                  position: location(p.target),
                  frame: "world",
                },
              ],
            };
          const load = body(p.material),
            targetDevice = owner(p.target),
            support = supportBody(surface(targetDevice.instance_id));
          const pose = physics.readBody!(load.id),
            capture = new Vector3(0, load.size[1] / 2 + 0.025, 0)
              .applyQuaternion(new Quaternion(...pose.rotation))
              .add(new Vector3(...pose.position));
          const flow = (
            targetDevice.contract.type_specific_contract as {
              surface: { flow_axis: Vec3 };
            }
          ).surface.flow_axis;
          const place = new Vector3(...location(p.target)).addScaledVector(
            new Vector3(...flow),
            Math.hypot(...load.size) + 0.02,
          );
          place.y =
            support.position[1] +
            support.size[1] / 2 +
            load.size[1] / 2 +
            0.008;
          const scene = {
            ...base,
            physics: {
              ...compiled.physics,
              bodies: [
                support,
                ...compiled.physics.bodies!.filter((b) => b.id !== support.id),
              ],
            },
            materialInstanceId: p.material,
            subjectId: p.material,
            materialBodyId: load.id,
            materialSize: load.size,
            materialMass: load.mass,
            supportSurfaceId: surface(targetDevice.instance_id),
            placementCenter: place.toArray(),
          };
          const safeY = Math.max(pose.position[1], place.y) + base.liftHeight;
          const move = (
            position: Vector3,
            held = false,
            clearance = false,
          ): RobotStep => ({
            kind: "move_to_pose",
            position: position.toArray(),
            frame: "world",
            subject: held ? "held_material" : "tcp",
            support_clearance: clearance,
            ...(held ? { world_rotation: pose.rotation } : {}),
          });
          const lift = Array.from({ length: 10 }, (_, i) =>
            move(
              new Vector3(...pose.position).add(
                new Vector3(0, ((safeY - pose.position[1]) * (i + 1)) / 10, 0),
              ),
              true,
            ),
          );
          const descend = Array.from({ length: 10 }, (_, i) =>
            move(
              place
                .clone()
                .add(new Vector3(0, ((safeY - place.y) * (9 - i)) / 10, 0)),
              true,
              i === 9,
            ),
          );
          const raised = new Vector3(pose.position[0], safeY, pose.position[2]),
            clear = new Vector3(pose.position[0], safeY, place.z),
            above = new Vector3(place.x, safeY, place.z);
          const segment = (a: Vector3, b: Vector3) =>
            Array.from({ length: 10 }, (_, i) =>
              move(a.clone().lerp(b, (i + 1) / 10), true),
            );
          return {
            scene,
            steps: [
              move(capture.clone().add(new Vector3(0, base.liftHeight, 0))),
              move(capture),
              { kind: "grip", materialId: p.material },
              ...lift,
              ...segment(raised, clear),
              ...segment(clear, above),
              ...descend,
              { kind: "release", materialId: p.material },
              move(above),
            ],
          };
        },
      );
      const submit = adapter.submit.bind(adapter),
        drain = adapter.drainFeedback.bind(adapter);
      adapter.submit = (r) => {
        requests.set(r.requestId, r);
        submit(r);
      };
      adapter.drainFeedback = () => {
        const feedback = drain();
        for (const f of feedback)
          if (f.status === "succeeded") {
            const r = requests.get(f.requestId);
            if (r?.behavior === "pick_and_place") {
              const p = (r.payload as { fields: Record<string, string> })
                .fields;
              robotHandoffs.set(p.material, {
                handler: id,
                receiver: owner(p.target).instance_id,
              });
            }
          }
        return feedback;
      };
      robotDrivers.set(id, adapter);
      return adapter;
    });
    for (const id of compiled.leaders.keys())
      drivers.push(
        factories.create(`conveyor@${device(id).contract.version}`, id),
      );
    for (const id of compiled.robots.keys())
      drivers.push(
        factories.create(`robot_arm@${device(id).contract.version}`, id),
      );
    const observationsByKey = new Set<string>();
    const observe = (key: string, provider: string) => {
      if (!observationsByKey.has(key)) {
        observationsByKey.add(key);
        observations.push({
          key,
          provider,
          maxAgeTicks: 1,
          validate: (v) => v !== null && typeof v === "object",
        });
      }
    };
    for (const id of positionConfigs.keys()) {
      observe(id + "/loads", "adapter:" + id);
      observe(id + "/transport", "adapter:" + id);
      observe(id + "/drive_state", "adapter:" + id);
    }
    for (const id of compiled.robots.keys())
      observe(id + "/robot_state", "adapter:" + id);
    const value = (c: ConditionContext, key: string, correlated = false) => {
      const s = c.observations?.samples[key];
      if (
        !s ||
        s.quality !== "good" ||
        s.runId !== runId ||
        (correlated &&
          (!c.request ||
            s.requestId !== c.request.requestId ||
            s.activationId !== c.request.activationId))
      )
        return undefined;
      return s.value;
    };
    const registered = new Set<string>();
    const register = (id: string, fn: (c: ConditionContext) => Truth) => {
      if (!registered.has(id)) {
        registered.add(id);
        providers.register(id, { evaluate: fn });
      }
    };
    const activeCarrier = (w: WorldObservation) =>
      compiled.task.pallets.find((p) => w.bodies[body(p.id).id]?.active);
    const allRobotsClear = (w: WorldObservation) =>
      [...compiled.robots.keys()].every((id) => w.robotClear[id]);
    for (const call of compiled.bundle.calls) {
      const d = device(call.device),
        driver = drivers.find((x) => x.id === call.device);
      if (!driver?.supports(call.behavior))
        throw new Error(
          "Missing executor " + call.device + "." + call.behavior,
        );
      const description = (
        d.contract.transport_behaviors as BehaviorDescription[]
      ).find((b) => b.behavior_id === call.behavior)!;
      const preSuffixes =
        call.behavior === "transport_to_position"
          ? ["ready", "motion_authorized"]
          : call.behavior === "stop_conveying"
            ? ["pre_1", "pre_2", "pre_3"]
            : call.behavior === "transport_to_exit"
              ? ["pre_1", "pre_2"]
              : ["pre_1"];
      const sameKeys = (actual: { key: string }[], expected: string[]) =>
        actual.length === expected.length &&
        expected.every((key) =>
          actual.some((c) => c.key === call.behavior + "." + key),
        );
      if (
        !description ||
        !sameKeys(description.condition_contract.preconditions, preSuffixes) ||
        !sameKeys(description.condition_contract.sustaining_conditions, [
          "sustaining",
        ]) ||
        !sameKeys(description.completion_contract.checks, ["completion"])
      )
        throw new Error(
          `Unsupported condition profile: ${call.device}.${call.behavior}`,
        );
      const robot = d.contract.device_type === "robot_arm",
        config = positionConfigs.get(call.device);
      const ready = (c: ConditionContext): Truth => {
        const w = world(c);
        if (!w) return undefined;
        if (robot) {
          const p = fields(c);
          if (call.behavior === "move_to_pose")
            return !w.bodies[compiled.robots.get(call.device)!.toolBodyId]
              ?.held;
          const id = String(p.material),
            load = w.bodies[body(id).id];
          if (
            !load?.active ||
            load.held ||
            Math.hypot(...load.pose!.velocity) > 0.03
          )
            return false;
          const src = owner(String(p.source)),
            dest = owner(String(p.target));
          const support =
            src.contract.device_type === "workpiece_carrier"
              ? body(src.instance_id).id
              : surface(src.instance_id);
          return (
            load.supports.includes(support) &&
            !activeBodiesFrom(w).some(
              (b) =>
                b.instanceId !== id &&
                w.bodies[b.id].supports.includes(surface(dest.instance_id)),
            ) &&
            [...positionConfigs.values()]
              .filter((p) => p.drives.some((x) => x.device === src.instance_id))
              .every(
                (p) =>
                  c.frame.samples[`${sceneId}/${p.leader}/runningTag`]
                    ?.value === false,
              )
          );
        }
        if (call.behavior === "stop_conveying") return true;
        const subject = config!.subjects.get(Number(args(c).subject_id));
        if (!subject) return false;
        const state = w.bodies[subject.bodyId];
        if (!state?.active) return false;
        const supported = [
          ...config!.drives.map((d) => d.surfaceId),
          ...(config!.admissionSupportIds ?? []),
        ].some((s) => state.supports.includes(s));
        if (!supported || Math.hypot(...state.pose!.velocity) > 0.03)
          return false;
        if (config!.drives.length > 1) {
          const p = activeCarrier(w);
          return (
            p?.id === subject.id &&
            w.receipts.some(
              (r) => r.kind === "supply_confirmed" && r.subjectId === p.id,
            ) &&
            allRobotsClear(w) &&
            (args(c).target !== call.device + ".exit" ||
              p.items.every((i) =>
                w.receipts.some(
                  (r) =>
                    r.kind === "material_delivered" &&
                    r.subjectId === i.material,
                ),
              ))
          );
        }
        return true;
      };
      const activeBodiesFrom = (w: WorldObservation) =>
        [...compiled.bodyMap.values()].filter(
          (b) => b.motionType === "dynamic" && w.bodies[b.id]?.active,
        );
      const sustained = (c: ConditionContext): Truth => {
        const w = world(c);
        if (!w) return undefined;
        if (config && config.drives.length > 1) return allRobotsClear(w);
        return (
          c.frame.samples[`${sceneId}/${call.device}/error`]?.value !== true
        );
      };
      const completed = (c: ConditionContext): Truth => {
        if (robot) {
          const state = value(c, call.device + "/robot_state", true) as
            { holding: boolean; qdot: number[] } | undefined;
          return state
            ? state.holding === false &&
                state.qdot.every(
                  (v) =>
                    Math.abs(v) <=
                    compiled.robots.get(call.device)!.settleSpeed,
                )
            : undefined;
        }
        if (call.behavior === "stop_conveying")
          return (
            c.frame.samples[`${sceneId}/${call.device}/actual_speed`]
              ?.quality === "good" &&
            Math.abs(
              Number(
                c.frame.samples[`${sceneId}/${call.device}/actual_speed`].value,
              ),
            ) <= 0.02
          );
        const subject = config!.subjects.get(Number(args(c).subject_id));
        if (!subject) return false;
        if (call.behavior === "release_material") {
          const w = world(c);
          return w
            ? w.receipts.some(
                (r) =>
                  r.kind === "material_delivered" && r.subjectId === subject.id,
              )
            : undefined;
        }
        const state = value(c, call.device + "/transport", true) as
          | {
              subject: string;
              target: string;
              distance: number;
              stationary: boolean;
              supported: boolean;
            }
          | undefined;
        return state
          ? state.subject === subject.id &&
              state.target === (args(c).target ?? call.device + ".exit") &&
              state.distance <= config!.positionTolerance &&
              state.stationary &&
              state.supported
          : undefined;
      };
      const stopped = call.device + "/assembly.stopped";
      register(stopped, (c) => {
        const w = world(c);
        if (!w) return undefined;
        if (robot) {
          const state = value(c, call.device + "/robot_state") as
            { qdot: number[]; holding: boolean } | undefined;
          return state
            ? state.qdot.every(
                (v) =>
                  Math.abs(v) <= compiled.robots.get(call.device)!.settleSpeed,
              ) && !state.holding
            : undefined;
        }
        return config!.drives.every(
          (d) =>
            c.frame.samples[`${sceneId}/${d.device}/actual_speed`]?.quality ===
              "good" &&
            Math.abs(
              Number(
                c.frame.samples[`${sceneId}/${d.device}/actual_speed`].value,
              ),
            ) <= 0.02,
        );
      });
      const expressionRules =
        conditionMode === "legacy"
          ? []
          : compileConditions(call.device, d.contract, call.behavior);
      const readBinding = sceneConditionReader(
        sceneId,
        call.device,
        compiled,
        positionConfigs,
        bindings,
      );
      const registerBehavior = (
        id: string,
        legacy: (c: ConditionContext) => Truth,
      ) => {
        if (registered.has(id)) return;
        const rule = expressionRules.find((r) => r.key === id);
        if (conditionMode === "legacy") {
          register(id, legacy);
          return;
        }
        if (!rule) throw new Error("Missing compiled condition: " + id);
        for (const b of Object.values(rule.bindings))
          if (
            (b.kind === "observation" || b.kind === "authorization") &&
            (!sceneConditionProviderIds.has(b.provider) ||
              !supportsSceneConditionBinding(b, d.contract.device_type))
          )
            throw new Error(
              "Unregistered condition leaf provider: " + b.provider,
            );
        registered.add(id);
        providers.registerExpression(rule, readBinding, legacy);
      };
      for (const condition of description.condition_contract.preconditions)
        registerBehavior(
          call.device + "/" + condition.key,
          condition.source === "authorization"
            ? (c) => ready(c) === true && c.owns("device/" + call.device)
            : ready,
        );
      for (const condition of description.condition_contract
        .sustaining_conditions)
        registerBehavior(call.device + "/" + condition.key, sustained);
      for (const condition of description.completion_contract.checks)
        registerBehavior(call.device + "/" + condition.key, completed);
      const key = call.device + "." + call.behavior;
      if (bindings.some((b) => b.device + "." + b.behavior === key)) continue;
      bindings.push(
        bindDeviceBehavior(call.device, d.contract, call.behavior, {
          contractVersion: String(d.contract.version),
          parameters: d.parameters,
          stopped: [stopped],
          resources: (c) => {
            if (robot) {
              const p = fields(c);
              return p.material
                ? [
                    "material/" + p.material,
                    "capacity/" + owner(String(p.target)).instance_id,
                  ]
                : [];
            }
            const p = config!.subjects.get(Number(args(c).subject_id)),
              carrier = compiled.task.pallets.find((x) => x.id === p?.id);
            return [
              ...config!.drives.map((d) => "device/" + d.device),
              "capacity/" + call.device,
              ...(p ? ["material/" + p.id] : []),
              ...(carrier
                ? [
                    ...carrier.items.map((i) => "material/" + i.material),
                    ...[...compiled.robots.keys()].map((id) => "device/" + id),
                  ]
                : []),
            ];
          },
          validatePayload: (p) => {
            if (robot) {
              const f = (p as { fields?: Record<string, unknown> })?.fields;
              if (
                !f ||
                typeof f.target !== "string" ||
                (call.behavior === "pick_and_place" &&
                  (typeof f.material !== "string" ||
                    typeof f.source !== "string"))
              )
                throw new Error("Invalid robot payload");
            } else if (p !== undefined)
              throw new Error("Conveyor uses scalar arguments");
          },
        }),
      );
    }
    const envObservations: ObservationWrite[] = [];
    let environmentStopping = false;
    const receipts = () => environment.snapshot();
    const environmentDriver: DeviceActionPort = {
      id: "@environment",
      supports: () => false,
      prepare: () => {
        throw new Error("Environment is lifecycle-managed");
      },
      prepareCancel: () => [],
      prepareStop: () => [],
      submit: () => {},
      cancel: () => {},
      requestStop: () => {
        environmentStopping = true;
        physics.setSurfaceSpeeds!({ [surface(compiled.sourceDevice)]: 0 });
      },
      isStopped: () =>
        physics.getSurfaceSpeed!(surface(compiled.sourceDevice)) === 0,
      dispose: () => {},
      drainFeedback: () => [],
      drainSignals: () => [],
      drainObservations: () => envObservations.splice(0),
      beforePhysics: (_dt, tick) => {
        if (environmentStopping) return;
        const departed = new Set(
          receipts()
            .filter((r) => r.kind === "carrier_departed")
            .map((r) => r.subjectId),
        );
        const current = loads.find((l) => !departed.has(l.carrier.id));
        if (current) {
          environment.admit(current.carrier.id, tick);
          const speed = physics.hasSupport(
            current.carrier.bodyId,
            surface(compiled.sourceDevice),
          )
            ? physics.getSurfaceSpeed!(surface(compiled.entryDevice))
            : 0;
          physics.setSurfaceSpeeds!({
            [surface(compiled.sourceDevice)]: speed,
          });
        }
      },
      afterPhysics: (_dt, tick) => {
        for (const load of loads) {
          if (!physics.isBodyActive!(load.carrier.bodyId)) continue;
          environment.observeSupply(load.carrier.id, tick);
          const target = positionConfigs
            .get(compiled.exitDevice)
            ?.targets.find((t) => t.id === compiled.exitDevice + ".exit");
          if (
            target &&
            !environmentStopping &&
            positionDrivers
              .get(compiled.exitDevice)
              ?.completedAt(load.carrier.id, target.id)
          )
            environment.takeCarrier(
              load.carrier.id,
              handoff(load.carrier.id, target),
              tick,
            );
        }
        const bodies: WorldObservation["bodies"] = {};
        for (const b of compiled.physics.bodies!) {
          const active = physics.isBodyActive!(b.id);
          bodies[b.id] = {
            active,
            pose: active ? physics.readBody!(b.id) : undefined,
            supports: active
              ? allSupports.filter((s) => physics.hasSupport(b.id, s))
              : [],
            held: physics.hasGraspForBody!(b.id),
          };
        }
        const robotClear: Record<string, boolean> = {};
        for (const [id, robot] of compiled.robots) {
          const pose = physics.readBody!(robot.toolBodyId),
            home = location(id + ".home");
          robotClear[id] =
            new Vector3(...pose.position).distanceTo(new Vector3(...home)) <=
              robot.tolerance * 2 &&
            Math.hypot(...pose.velocity) <= 0.03 &&
            !physics.hasGraspForBody!(robot.toolBodyId);
        }
        envObservations.push({
          key: "world/state",
          provider: "physics",
          runId,
          value: {
            bodies,
            robotClear,
            receipts: receipts(),
            deliveries: { ...actualDeliveries },
          },
        });
      },
    };
    drivers.push(environmentDriver);
    observe("world/state", "physics");
    register("goal/complete", (c) => {
      const w = world(c);
      if (!w) return undefined;
      return (
        environment.complete() &&
        compiled.goals.deliveries.every(
          (goal) =>
            w.deliveries[goal.material]?.handler === goal.handler &&
            w.deliveries[goal.material]?.target === goal.target,
        ) &&
        allRobotsClear(w) &&
        [...positionConfigs.values()].every((p) =>
          p.drives.every(
            (d) =>
              c.frame.samples[`${sceneId}/${d.device}/runningTag`]?.value ===
              false,
          ),
        )
      );
    });
    const scope: Record<string, unknown> = { task: compiled.task };
    for (const d of compiled.devices.values()) {
      scope[d.instance_id] = d.instance_id;
      for (const key of Object.keys(d.locations)) scope[key] = key;
    }
    const process = bindProcess(compiled.root, {
      scope,
      actions: bindings,
      providers,
      finalization: ["goal/complete"],
      readers: {
        subject_id: (args) => {
          const value = compiled.subjectIds.get(String(args[0]));
          if (!value) throw new Error("Unknown subject identity");
          return value;
        },
      },
    });
    const registry = new ObservationRegistry(runId, observations);
    // Initialise support and inventory evidence without advancing the process or issuing commands.
    let initialized = false;
    for (let step = 0; step < 120; step++) {
      for (const driver of drivers) driver.beforePhysics(1 / 60, 0);
      physics.step(1 / 60);
      for (const driver of drivers) driver.afterPhysics(1 / 60, 0);
      signals.publishFeedback(
        drivers.flatMap((d) => [...d.drainSignals()]),
        0,
      );
      registry.publish(
        drivers.flatMap((d) => [...(d.drainObservations?.() ?? [])]),
        0,
      );
      if (receipts().some((r) => r.kind === "supply_confirmed")) {
        initialized = true;
        break;
      }
    }
    if (!initialized)
      throw new Error(
        "Initial carrier support/stability was not confirmed within 120 physical steps",
      );
    const program = new SceneRuntimeProgram(
      sceneId,
      runId,
      process,
      signals,
      physics,
      drivers,
      registry,
    );
    return { program, compiled };
  } catch (e) {
    physics.dispose();
    throw e;
  }
}

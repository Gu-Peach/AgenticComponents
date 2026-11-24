/** 为双臂交接工位装配输送带、机械臂和供收料环境，将 DSL 动作绑定到设备，并用交接记录和出口姿态验证交付。 */

import {
  connectedFactsHold,
  factKey,
  type FactReceipt,
  type SemanticFact,
} from "@/domain/runtime/compileSignalConnections";
import { getDeviceModule } from "@/devices/registry";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import type { ActionBinding, ActionRequest } from "@/contracts/scheduler";
import type {
  ConditionContext,
  ObservationWrite,
  Truth,
} from "@/contracts/conditions";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import {
  bindDeviceBehavior,
  signalLayoutFromContract,
} from "@/domain/runtime/bindDeviceBehavior";
import { bindProcess } from "@/domain/runtime/bindProcess";
import { compileConditions } from "@/domain/runtime/compileConditions";
import { SceneRuntimeProgram } from "@/runtime/engine/SceneRuntimeProgram";
import { createJoltBackend } from "@/runtime/physics/jolt/JoltPhysicsBackend";
import { MaterialPoseObserver } from "@/runtime/engine/MaterialPoseObserver";
import type { RobotTransferActions } from "@/devices/robot_arm/behavior";
import type { PhysicsPort } from "@/contracts/physics";
import {
  ConditionProviders,
  ObservationRegistry,
  SignalRegistry,
} from "@/runtime/signals";
import { ConditionTrace } from "@/runtime/signals/ConditionTrace";

interface HandoffState {
  factReceipts: FactReceipt[];
  active: string | null;
  arms: Record<string, { atHome: boolean; stopped: boolean; held?: string }>;
  onInfeed: boolean;
  atPickup: boolean;
  supportedOnInfeed: boolean;
  pickReady: boolean;
  onOutfeed: boolean;
  exitReady: boolean;
  placed: string[];
  transfers: RobotTransferActions["transfers"];
  delivered: { material: string; target: string; tick: number }[];
}

export function bindRobotTransfers(
  compiled: CompiledSceneRuntime,
  physics: PhysicsPort,
) {
  const config = compiled.handoff!,
    robot = getDeviceModule("robot_arm");
  const arms = new Map(
    [...compiled.robots].map(([id, model]) => [
      id,
      robot.createArticulatedArm(model, config.approachAxes.get(id)!, physics),
    ]),
  );
  const observed = new MaterialPoseObserver(
    config.materialFrames,
    config.transportPoses,
    compiled.devices,
    compiled.bodyMap,
    physics,
  );
  return {
    observed,
    actions: robot.createTransferActions(
      arms,
      compiled.devices,
      observed,
      physics,
    ),
  };
}

export async function assembleHandoffRuntime(
  sceneId: string,
  runId: string,
  compiled: CompiledSceneRuntime,
) {
  const config = compiled.handoff!;
  const { source, infeed, outfeed, giver, receiver } = config;
  const physics = await createJoltBackend(compiled.physics);
  try {
    const { observed, actions: line } = bindRobotTransfers(compiled, physics);
    const devices = compiled.devices;
    const ids = [...compiled.subjectIds];
    const subject = (r: ActionRequest) =>
      ids.find(([, id]) => id === Number(r.arguments.subject_id))?.[0];
    const { pickup: input, delivery: output, placement: place } = config;
    let current = 0,
      closing = false;
    const receipts: HandoffState["delivered"] = [];
    const mode = (r: { device: string; behavior: string }) =>
      config.actionModes.get(r.device + "." + r.behavior) ?? r.behavior;
    const currentId = () => config.jobs[current]?.material;
    const location = (device: string, key: string) =>
      devices.get(device)!.locations[key];
    const factReceipts: FactReceipt[] = [];
    // Only receipts produced by successful, physically verified jobs may supply a downstream step.
    function recordFacts(r: ActionRequest) {
      const id =
        (r.payload as { fields?: { material?: string } } | undefined)?.fields
          ?.material ?? subject(r);
      if (!id) return;
      const step = program.scheduler
        .snapshot()
        .activations.find(
          (a) => a.id === r.activationId && a.requestId === r.requestId,
        );
      if (!step)
        throw new Error("Missing active fact producer: " + r.activationId);
      const effects = (config.connections.get(id) ?? []).filter(
        (e) => e.producer === step.node || e.alternatives.includes(step.node),
      );
      const distinct = new Map<string, SemanticFact>();
      for (const e of effects) {
        const f: SemanticFact = {
          semantic: e.semantic,
          subject: e.subject,
          endpoint: e.endpoint,
        };
        if (f.subject !== id)
          throw new Error("Incorrect handoff fact identity");
        let confirmed = false;
        if (f.semantic === "held_by") {
          const arm = line.arm(f.endpoint);
          confirmed = arm.holding && arm.held === id;
        } else if (f.endpoint === input) {
          confirmed =
            f.semantic === "at"
              ? observed.atEndpoint(id, infeed, input)
              : f.semantic === "supported_at" && observed.onBelt(id, infeed);
        }
        if (!confirmed)
          throw new Error("Unconfirmed handoff fact " + factKey(f));
        distinct.set(factKey(f), f);
      }
      for (const fact of distinct.values())
        factReceipts.push({
          producer: step.node,
          runId,
          activationId: r.activationId,
          requestId: r.requestId,
          fact,
        });
    }
    const belts = [infeed, outfeed].map((id) => {
      const params = devices.get(id)!.parameters,
        speed = Number(params.speed_mps);
      const belt = getDeviceModule("conveyor").createSceneDriver(
        {
          sceneId,
          runId,
          leader: id,
          drives: [
            {
              device: id,
              surfaceId: id + "/surface",
              flow: compiled.physics.surfaces!.find(
                (s) => s.id === id + "/surface",
              )!.direction,
            },
          ],
          subjects: new Map(
            ids.map(([material, index]) => [
              index,
              {
                id: material,
                bodyId: observed.body(material).id,
                referenceOffset:
                  config.materialFrames.get(material)!.points[
                    config.transportPoses.get(id)!.contactFrame
                  ].offset,
              },
            ]),
          ),
          targets: [
            {
              id: id === infeed ? input : output,
              index: 1,
              position: location(id, id === infeed ? input : output).position,
              supportIds: [id + "/surface"],
            },
          ],
          admissionSupportIds: id === infeed ? [source + "/surface"] : [],
          maxSpeed: speed,
          acceleration: speed / Number(params.accel_time_s),
          deceleration: speed / Number(params.decel_time_s),
          positionTolerance: 0.012,
          speedTolerance: 0.02,
          verticalTolerance: 0.018,
          settleTicks: 6,
          inventoryFeedback: {
            partReadyPort: "part_ready",
            capacityPort: "capacity_available",
            capacity: 1,
          },
          releasePermissionPort: "release_waiting_material",
          publishDriveState: true,
          onSucceeded: recordFacts,
        },
        physics,
        id === outfeed
          ? (item, target, tick) => {
              if (
                closing ||
                item.id !== currentId() ||
                !observed.checkPose(item.id, outfeed, target.id)
              )
                return false;
              physics.deactivateBodies!([item.bodyId]);
              receipts.push({ material: item.id, target: target.id, tick });
              current++;
              return true;
            }
          : undefined,
      );
      return belt;
    });
    const robots = [giver, receiver].map((id) => {
      const arm = line.arm(id);
      return getDeviceModule("robot_arm").createJobDriver(
        id,
        sceneId,
        runId,
        [
          "move_to_pose",
          id === giver ? "pick_and_handoff" : "place_held_material",
          ...(config.actionModes.has(id + ".pick_and_place")
            ? ["pick_and_place"]
            : []),
        ],
        (request) => line.prepare(request),
        () => arm.stopped,
        () => arm.holding,
        "start_pick",
        recordFacts,
      );
    });
    const supply = getDeviceModule("material_source_station").createSupply(
      physics,
    );
    let pending: ObservationWrite[] = [];
    const environment: DeviceActionPort = {
      id: "@handoff-environment",
      supports: () => false,
      prepare: () => {
        throw new Error("Environment is not an actuator");
      },
      prepareCancel: () => [],
      prepareStop: () => [],
      submit: () => {},
      cancel: () => {},
      dispose: () => {},
      requestStop: () => {
        closing = true;
        for (const arm of line.arms.values()) arm.stop();
      },
      isStopped: () =>
        [...line.arms.values()].every((a) => a.stopped && !a.holding),
      beforePhysics: (dt) => {
        const id = currentId();
        if (!closing && id && !physics.isBodyActive!(observed.body(id).id)) {
          const body = observed.body(id);
          supply.presentAtRest([body]);
        }
        physics.setSurfaceSpeeds!({
          [source + "/surface"]: closing
            ? 0
            : physics.getSurfaceSpeed!(infeed + "/surface"),
        });
        for (const arm of line.arms.values()) arm.step(dt);
      },
      afterPhysics: () => {
        const active = currentId();
        const eligible =
          !!active && physics.isBodyActive!(observed.body(active).id);
        const state: HandoffState = {
          factReceipts,
          active: active ?? null,
          arms: Object.fromEntries(
            [...line.arms].map(([id, a]) => [
              id,
              {
                atHome: a.atHome,
                stopped: a.stopped,
                held: a.holding ? a.held : undefined,
              },
            ]),
          ),
          onInfeed:
            eligible &&
            (observed.onBelt(active, infeed) ||
              physics.hasContactSupport!(
                observed.body(active).id,
                source + "/surface",
              )),
          atPickup: eligible && observed.atEndpoint(active, infeed, input),
          supportedOnInfeed: eligible && observed.onBelt(active, infeed),
          pickReady: eligible && observed.checkPose(active, infeed, input),
          onOutfeed: eligible && observed.onBelt(active, outfeed),
          exitReady: eligible && observed.checkPose(active, outfeed, output),
          placed: [...line.placed],
          transfers: line.transfers,
          delivered: receipts,
        };
        pending = [
          { key: "handoff/state", provider: "physics", runId, value: state },
          {
            key: "world/state",
            provider: "physics",
            runId,
            value: {
              bodies: Object.fromEntries(
                ids.map(([id]) => {
                  const body = observed.body(id),
                    present = physics.isBodyActive!(body.id);
                  return [
                    body.id,
                    {
                      active: present,
                      pose: present ? observed.materialPose(id) : undefined,
                    },
                  ];
                }),
              ),
            },
          },
          ...robots.map((adapter) => ({
            key: adapter.id + "/robot_state",
            provider: "physics",
            runId,
            requestId: adapter.request?.requestId,
            activationId: adapter.request?.activationId,
            subjectId: adapter.request?.subjectId,
            value: {
              q: line.arm(adapter.id).q,
              qdot: line.arm(adapter.id).qdot,
              tcp: line.arm(adapter.id).pose,
              holding: line.arm(adapter.id).holding,
            },
          })),
        ];
      },
      drainSignals: () => [],
      drainFeedback: () => [],
      drainObservations: () => {
        const value = pending;
        pending = [];
        return value;
      },
    };
    const drivers: DeviceActionPort[] = [...belts, ...robots, environment];
    const signals = new SignalRegistry(
      runId,
      [...devices.values()]
        .filter((d) => !d.asset_kind?.endsWith("_prefab"))
        .flatMap((d) =>
          signalLayoutFromContract(sceneId, d.instance_id, d.contract),
        ),
    );
    const obs = (key: string, provider: string) => ({
      key,
      provider,
      maxAgeTicks: 1,
      validate: (v: unknown) => !!v && typeof v === "object",
    });
    const observations = new ObservationRegistry(runId, [
      obs("handoff/state", "physics"),
      obs("world/state", "physics"),
      ...robots.map((r) => obs(r.id + "/robot_state", "physics")),
      ...belts.flatMap((b) =>
        ["loads", "transport", "drive_state"].map((key) =>
          obs(b.id + "/" + key, "adapter:" + b.id),
        ),
      ),
    ]);
    const state = (c: ConditionContext) => {
      const s = c.observations?.samples["handoff/state"];
      return s?.quality === "good" && s.runId === runId
        ? (s.value as HandoffState)
        : undefined;
    };
    const fields = (r: ActionRequest) =>
      (r.payload as { fields?: Record<string, string> } | undefined)?.fields ??
      {};
    const footprint = (r: ActionRequest) => {
      const material = fields(r).material ?? subject(r);
      const devices =
        mode(r) === "pick_and_handoff"
          ? [giver, receiver, infeed]
          : mode(r) === "place_held_material"
            ? [receiver, outfeed]
            : [r.device];
      return [
        ...devices.map((d) => "device/" + d),
        ...(material ? ["material/" + material] : []),
      ];
    };
    const driveStopped = (c: ConditionContext, d: string) => {
      const s = c.frame.samples[sceneId + "/" + d + "/actual_speed"];
      return s?.quality === "good" && Math.abs(Number(s.value)) <= 0.02;
    };
    function connected(c: ConditionContext, w: HandoffState, material: string) {
      const edges = config.connections.get(material);
      if (!edges || !c.nodeId || !c.activationId) return false;
      const live = (f: SemanticFact) => {
        if (w.active !== f.subject || f.subject !== material) return false;
        if (f.semantic === "held_by")
          return w.arms[f.endpoint]?.held === material;
        if (f.endpoint === input && f.semantic === "at") return w.atPickup;
        if (f.endpoint === input && f.semantic === "supported_at")
          return w.supportedOnInfeed;
        return undefined;
      };
      return connectedFactsHold(
        edges,
        c.nodeId,
        c,
        w.factReceipts,
        live,
        (producer) => c.successfulPredecessor?.(producer),
      );
    }
    const ready = (c: ConditionContext, r: ActionRequest, w: HandoffState) => {
      const material = fields(r).material ?? subject(r);
      switch (mode(r)) {
        case "move_to_pose":
          return w.arms[r.device].stopped && !w.arms[r.device].held;
        case "pick_and_handoff":
          return (
            material === w.active &&
            connected(c, w, material) === true &&
            w.pickReady &&
            w.arms[r.device].stopped &&
            !w.arms[r.device].held &&
            w.arms[fields(r).receiver].stopped &&
            !w.arms[fields(r).receiver].held &&
            driveStopped(c, infeed)
          );
        case "place_held_material":
          return (
            material === w.active &&
            connected(c, w, material) === true &&
            w.arms[receiver].held === material &&
            w.arms[receiver].stopped &&
            driveStopped(c, outfeed)
          );
        case "stop_conveying":
          return driveStopped(c, r.device);
        case "release_material":
          return (
            material === w.active && w.exitReady && driveStopped(c, outfeed)
          );
        case "transport_to_position":
          return (
            material === w.active &&
            driveStopped(c, r.device) &&
            (r.device === infeed ? w.onInfeed : w.onOutfeed)
          );
        default:
          return false;
      }
    };
    const completed = (
      c: ConditionContext,
      r: ActionRequest,
      w: HandoffState,
    ) => {
      if (c.requestState?.outcome !== "succeeded") return false;
      const material = fields(r).material ?? subject(r);
      switch (mode(r)) {
        case "move_to_pose":
          return w.arms[r.device].atHome;
        case "pick_and_handoff":
          return (
            w.arms[receiver].held === material &&
            !w.arms[giver].held &&
            w.transfers.some(
              (t) =>
                t.material === material &&
                t.from === giver &&
                t.to === receiver,
            )
          );
        case "place_held_material":
          return (
            !w.arms[receiver].held &&
            w.onOutfeed &&
            w.placed.includes(material!)
          );
        case "stop_conveying":
          return driveStopped(c, r.device);
        case "release_material":
          return w.delivered.some(
            (t) => t.material === material && t.target === output,
          );
        case "transport_to_position":
          return r.device === infeed ? w.pickReady : w.exitReady;
      }
      return false;
    };
    const unique = new Map(
      compiled.bundle.calls.map((c) => [c.device + "." + c.behavior, c]),
    );
    const providers = new ConditionProviders(new ConditionTrace("expression"));
    const actions: ActionBinding[] = [];
    for (const call of unique.values()) {
      const d = devices.get(call.device)!;
      const behavior = mode(call);
      if (
        !drivers.some((a) => a.id === call.device && a.supports(call.behavior))
      )
        throw new Error("Unsupported handoff action");
      for (const rule of compileConditions(call.device, d.contract, behavior)) {
        if (rule.expr.op !== "opaque")
          throw new Error(
            "Handoff action requires its native condition profile",
          );
        const evaluate = (c: ConditionContext): Truth => {
          const w = state(c),
            r = c.request as ActionRequest | undefined;
          if (!w || !r) return undefined;
          if (rule.phase === "precondition") return ready(c, r, w);
          if (rule.phase === "authorization")
            return ready(c, r, w) && footprint(r).every((k) => c.owns(k));
          if (rule.phase === "completion") return completed(c, r, w);
          if (rule.phase === "sustaining") {
            if (r.device === outfeed && r.behavior === "transport_to_position")
              return w.onOutfeed;
            return (
              c.frame.samples[sceneId + "/" + r.device + "/error"]?.value ===
              false
            );
          }
          return false;
        };
        providers.registerExpression(
          rule,
          () => {
            throw new Error("Unexpected handoff leaf");
          },
          evaluate,
        );
      }
      const stopped = call.device + "/" + call.behavior + ".stopped";
      providers.register(stopped, {
        evaluate: (c) => {
          const w = state(c);
          return (
            w && (w.arms[call.device]?.stopped ?? driveStopped(c, call.device))
          );
        },
      });
      actions.push({
        ...bindDeviceBehavior(call.device, d.contract, behavior, {
          contractVersion: String(d.contract.version),
          parameters: d.parameters,
          stopped: [stopped],
          resources: (c) => footprint(c.request as ActionRequest),
          validatePayload: (p) => {
            if (!line.arms.has(call.device)) {
              if (p !== undefined)
                throw new Error("Conveyor only accepts scalar args");
              return;
            }
            const v = p as
                | { binding?: string; fields?: Record<string, string> }
                | undefined,
              f = v?.fields;
            if (v?.binding !== call.device + "." + behavior || !f)
              throw new Error("Invalid handoff payload binding");
            if (behavior === "move_to_pose") {
              if (
                devices.get(call.device)?.locations[f.target]?.reference !==
                "robot_rest_pose"
              )
                throw new Error("Invalid retreat target");
              return;
            }
            if (!compiled.subjectIds.has(f.material))
              throw new Error("Unknown workpiece identity");
            if (
              behavior === "pick_and_handoff" &&
              (f.source !== input ||
                f.target !== config.rendezvous ||
                f.receiver !== receiver ||
                f.giver_grasp === f.receiver_grasp ||
                !Object.hasOwn(
                  config.materialFrames.get(f.material)!.points,
                  f.giver_grasp,
                ) ||
                !Object.hasOwn(
                  config.materialFrames.get(f.material)!.points,
                  f.receiver_grasp,
                ))
            )
              throw new Error("Invalid handoff endpoint or material interface");
            if (
              behavior === "place_held_material" &&
              (f.target !== place ||
                !Object.hasOwn(
                  config.materialFrames.get(f.material)!.points,
                  f.grasp,
                ))
            )
              throw new Error(
                "Invalid placement endpoint or material interface",
              );
          },
        }),
        behavior: call.behavior,
      });
    }
    providers.register("handoff/goal", {
      evaluate: (c) => {
        const w = state(c);
        return (
          w &&
          w.active === null &&
          w.delivered.length === config.jobs.length &&
          config.jobs.every((j) =>
            w.delivered.some(
              (r) => r.material === j.material && r.target === j.target,
            ),
          ) &&
          Object.values(w.arms).every((a) => a.stopped && !a.held) &&
          driveStopped(c, infeed) &&
          driveStopped(c, outfeed)
        );
      },
    });
    const scope: Record<string, unknown> = { task: compiled.task };
    for (const d of devices.values()) {
      scope[d.instance_id] = d.instance_id;
      for (const key of Object.keys(d.locations)) scope[key] = key;
    }
    const process = bindProcess(compiled.root, {
      scope,
      actions,
      providers,
      finalization: ["handoff/goal"],
      readers: { subject_id: (a) => compiled.subjectIds.get(String(a[0])) },
    });
    for (let i = 0; i < 35; i++) {
      drivers.forEach((d) => d.beforePhysics(1 / 60, 0));
      physics.step(1 / 60);
      drivers.forEach((d) => d.afterPhysics(1 / 60, 0));
      signals.publishFeedback(
        drivers.flatMap((d) => [...d.drainSignals()]),
        0,
      );
      observations.publish(
        drivers.flatMap((d) => [...(d.drainObservations?.() ?? [])]),
        0,
      );
    }
    const first = observed.body(currentId()!);
    if (
      !physics.hasContactSupport!(first.id, source + "/surface") ||
      Math.hypot(...physics.readBody!(first.id).velocity) > 0.02
    )
      throw new Error("首件物料未在供料口稳定支承");
    const program: SceneRuntimeProgram = new SceneRuntimeProgram(
      sceneId,
      runId,
      process,
      signals,
      physics,
      drivers,
      observations,
    );
    return { compiled, program };
  } catch (e) {
    physics.dispose();
    throw e;
  }
}

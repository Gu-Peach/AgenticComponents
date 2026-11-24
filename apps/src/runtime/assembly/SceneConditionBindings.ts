import { isCarryingWorkpiece } from "@/devices/workpiece/behavior";
/** 把设备契约中的条件绑定到当前调度步的信号、物理观测、请求和资源状态，供调度器判定动作能否开始或完成。 */

import { Quaternion, Vector3 } from "three";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import type {
  ConditionContext,
  ObservationSample,
} from "@/contracts/conditions";
import type {
  BindingReading,
  ConditionBinding,
  Scalar,
} from "@/contracts/condition-expression";
import type { BodyPose } from "@/contracts/physics";
import type { ActionBinding } from "@/contracts/scheduler";
import type { PositionTransportConfig } from "@/devices/conveyor/behavior";
import type { EnvironmentReceipt } from "@/runtime/engine/FiniteBatchLifecycle";
import { RobotKinematics } from "@/runtime/kinematics/RobotKinematics";
import { CcdPositionIK } from "@/runtime/kinematics/CcdPositionIK";
import { restJointTarget } from "@/runtime/kinematics/restJointTarget";
import { DEFAULT_FEEDBACK_MAX_AGE_TICKS } from "@/domain/runtime/bindDeviceBehavior";

export interface SceneConditionWorld {
  bodies: Record<
    string,
    {
      active: boolean;
      pose?: BodyPose;
      supports: string[];
      held: boolean;
      materialState?: "raw" | "finished";
    }
  >;
  robotClear: Record<string, boolean>;
  receipts: EnvironmentReceipt[];
  deliveries: Record<
    string,
    { handler: string; receiver: string; target: string }
  >;
  /** Present for a finite loading manifest. Receipts are per run and slot. */
  loading?: {
    pallet: string | null;
    slots: Record<string, string>;
    fullAtExit: boolean;
  };
  machining?: {
    pallet: string | null;
    atStation: boolean;
    fullAtExit: boolean;
    completedLoad: boolean;
    machineItem: string | null;
    workSupported: boolean;
    slots: Record<string, string>;
    operations: ReadonlyArray<{
      material: string;
      request: string;
      tick: number;
    }>;
  };
}
type World = SceneConditionWorld;
interface RobotObservation {
  q: number[];
  qdot: number[];
  holding: boolean;
  motionIntegrity: boolean;
  placementConfirmed: boolean;
  targetError: number | null;
  orientationSatisfied: boolean;
}
interface TransportObservation {
  subject: string;
  target: string;
  distance: number;
  supported: boolean;
  stationary: boolean;
}
const robotProviders = [
  "source_pickable",
  "target_admissible",
  "phase_integrity",
  "placement_confirmed",
  "pose_plan_valid",
  "motion_integrity",
  "tcp_position_error_m",
  "max_joint_speed_rad_s",
  "requested_orientation_satisfied",
];
const conveyorProviders = [
  "target_and_subject_valid",
  "environment_ready",
  "motion_interlocks_clear",
  "transport_integrity",
  "target_error_m",
  "target_supported",
  "subject_and_drives_stationary",
  "subject_admitted",
  "exit_path_valid",
  "path_unblocked",
  "subject_at_exit",
  "receiver_admissible",
  "release_history_exists",
  "elapsed_since_release_s",
  "handoff_ownership_valid",
  "receiver_receipt",
  "subject_on_device",
  "already_stationary",
  "controlled_stop_supported",
  "load_tracking_available",
  "stop_retains_loads",
  "max_drive_speed_mps",
];
export const sceneConditionProviderIds = new Set([
  ...robotProviders.map((n) => "scene.robot_arm." + n + "@1"),
  ...conveyorProviders.map((n) => "scene.conveyor." + n + "@1"),
  "scheduler.resources_granted@1",
]);
export function supportsSceneConditionBinding(
  binding: ConditionBinding,
  deviceType: unknown,
) {
  if (binding.kind !== "observation" && binding.kind !== "authorization")
    return true;
  if (!sceneConditionProviderIds.has(binding.provider)) return false;
  if (binding.kind === "authorization")
    return (
      binding.provider === "scheduler.resources_granted@1" &&
      binding.value_type === "boolean" &&
      binding.unit === "1"
    );
  if (!binding.provider.startsWith(`scene.${String(deviceType)}.`))
    return false;
  const name = binding.provider.split(".").at(-1)!.split("@")[0];
  const numeric: Record<string, string> = {
    tcp_position_error_m: "m",
    max_joint_speed_rad_s: "rad/s",
    target_error_m: "m",
    elapsed_since_release_s: "s",
    max_drive_speed_mps: "m/s",
  };
  return (
    binding.value_type === (numeric[name] ? "number" : "boolean") &&
    binding.unit === (numeric[name] ?? "1")
  );
}
class MissingEvidence extends Error {
  constructor(readonly reading: BindingReading) {
    super(reading.reason);
  }
}

/** Reads frozen scheduler inputs. No writes, physics steps, or UI-derived truth. */
export function sceneConditionReader(
  sceneId: string,
  deviceId: string,
  compiled: CompiledSceneRuntime,
  configs: ReadonlyMap<string, PositionTransportConfig>,
  actions: readonly ActionBinding[],
) {
  const device = compiled.devices.get(deviceId)!,
    config = configs.get(deviceId);
  const owner = (location: unknown) => {
    const d = [...compiled.devices.values()].find((d) =>
      Object.hasOwn(d.locations, String(location)),
    );
    if (!d) throw new Error("Unresolved location: " + String(location));
    return d;
  };
  const canonical = (id: unknown) => {
    const text = String(id);
    return typeof id === "number"
      ? ([...compiled.subjectIds].find(([, index]) => index === id)?.[0] ??
          text)
      : text;
  };
  return (b: ConditionBinding, c: ConditionContext): BindingReading => {
    let sampledTick = c.frame.tick;
    const sources = new Set<string>();
    const fail = (
      source: string,
      reason: string,
      quality: BindingReading["quality"] = "unknown",
      tick = c.frame.tick,
    ): never => {
      throw new MissingEvidence({
        value: null,
        quality,
        sampledTick: tick,
        source,
        reason,
      });
    };
    const good = (value: Scalar | null, reason?: string): BindingReading => ({
      value,
      quality: value === null ? "unknown" : "good",
      sampledTick,
      source: [...sources].join(" + ") || b.kind,
      reason,
    });
    const correlated = (
      s: {
        runId: string;
        requestId?: string;
        activationId?: string;
        subjectId?: string;
      },
      scope: string,
    ) => {
      if (s.runId !== c.frame.runId) return false;
      if (
        scope.startsWith("request") &&
        (!c.request ||
          s.requestId !== c.request.requestId ||
          s.activationId !== c.request.activationId)
      )
        return false;
      return (
        !scope.endsWith("subject") ||
        (!!c.request?.subjectId && s.subjectId === c.request.subjectId)
      );
    };
    const sample = <T>(key: string, scope = "run"): T => {
      sources.add(key);
      const s = c.observations?.samples[key] as ObservationSample | undefined;
      if (!s) return fail(key, "observation missing");
      if (s.quality !== "good")
        return fail(key, "observation " + s.quality, s.quality, s.sampledTick);
      if (
        s.sampledTick > c.frame.tick ||
        c.frame.tick - s.sampledTick >
          (b.kind === "observation" ? b.max_age_ticks : 1)
      )
        return fail(key, "observation expired", "stale", s.sampledTick);
      if (!correlated(s, scope))
        return fail(
          key,
          "observation identity mismatch",
          "invalid",
          s.sampledTick,
        );
      sampledTick = Math.min(sampledTick, s.sampledTick);
      return s.value as T;
    };
    const signal = (port: string, scope = "run") => {
      const key = `${sceneId}/${deviceId}/${port}`;
      sources.add(key);
      const s = c.frame.samples[key];
      if (!s || s.quality !== "good")
        return fail(
          key,
          "signal " + (s?.quality ?? "missing"),
          s?.quality ?? "unknown",
          s?.sampledTick,
        );
      const definition = (
        device.contract.signal_ports as {
          port_id: string;
          retention: string;
          direction: string;
        }[]
      ).find((p) => p.port_id === port);
      if (
        definition?.direction === "output" &&
        definition.retention === "sampled_state" &&
        c.frame.tick - s.sampledTick > DEFAULT_FEEDBACK_MAX_AGE_TICKS
      )
        return fail(key, "signal expired", "stale", s.sampledTick);
      if (s.sampledTick > c.frame.tick || !correlated(s, scope))
        return fail(
          key,
          "signal identity or timestamp mismatch",
          "invalid",
          s.sampledTick,
        );
      sampledTick = Math.min(sampledTick, s.sampledTick);
      return s.value;
    };
    try {
      if (!supportsSceneConditionBinding(b, device.contract.device_type))
        return fail(
          "provider",
          "binding signature is not registered",
          "invalid",
        );
      if (b.kind === "signal") return good(signal(b.port, b.scope));
      if (b.kind === "parameter") {
        sources.add("parameters/" + b.parameter);
        return good(device.parameters[b.parameter] ?? null);
      }
      if (b.kind === "profile") {
        sources.add("profile/scene.assembly@1/" + b.parameter);
        return good(
          config
            ? b.parameter === "position_tolerance_m"
              ? config.positionTolerance
              : config.speedTolerance
            : null,
        );
      }
      if (b.kind === "request") {
        sources.add("RequestBook");
        if (!c.request || !c.requestState)
          return fail("RequestBook", "request not submitted");
        return good(
          c.requestState.accepted &&
            (b.field === "matching_accepted" ||
              c.requestState.outcome === "succeeded"),
        );
      }
      const args = (c.scope.arguments as Record<string, unknown>) ?? {},
        payload =
          (c.scope.payload as { fields?: Record<string, unknown> } | undefined)
            ?.fields ?? {};
      const resolved = Object.fromEntries(
        Object.entries(b.arguments).map(([name, ref]) => [
          name,
          ref.from === "self"
            ? deviceId
            : ref.from === "argument"
              ? args[ref.name]
              : payload[ref.name],
        ]),
      );
      if (Object.values(resolved).some((v) => v === undefined))
        return fail("arguments", "unresolved provider context");
      if (resolved.device !== deviceId)
        return fail(
          "arguments",
          "provider redirects device identity",
          "invalid",
        );
      const granted = () => {
        sources.add("ResourceArbiter");
        const action = actions.find(
          (a) => a.device === deviceId && a.behavior === b.behavior,
        );
        if (!action || !c.request)
          return fail("ResourceArbiter", "resource footprint missing");
        return ["device/" + deviceId, ...action.resources(c, args)].every(
          (key) => c.owns(key),
        );
      };
      if (b.kind === "authorization") return good(granted());
      if (!sceneConditionProviderIds.has(b.provider))
        return fail(b.provider, "provider not registered");
      const name = b.provider.split(".").at(-1)!.split("@")[0];
      const world = () => sample<World>("world/state");
      const subjectId = canonical(
        resolved.subject_id ?? resolved.material ?? c.request?.subjectId,
      );
      const load = (w: World) => {
        const state = w.bodies[subjectId + "/body"];
        if (!state) fail("world/state", "subject body is absent");
        return state;
      };
      const settled = (w: World) => {
        const s = load(w);
        return (
          s.active &&
          !s.held &&
          !!s.pose &&
          Math.hypot(...s.pose.velocity) <= 0.03
        );
      };
      const supported = (w: World) =>
        !!config &&
        load(w).active &&
        [
          ...config.drives.map((d) => d.surfaceId),
          ...(config.admissionSupportIds ?? []),
        ].some((s) => load(w).supports.includes(s));
      const robotsClear = (w: World) =>
        [...compiled.robots.keys()].every((id) => w.robotClear[id] === true);
      const receipt = (w: World) =>
        w.receipts.find(
          (r) =>
            r.runId === c.frame.runId &&
            r.subjectId === subjectId &&
            (w.loading || w.machining
              ? r.kind === "carrier_departed" &&
                (compiled.loading?.exchange.leader ??
                  compiled.machining?.leader) === deviceId
              : r.kind === "material_delivered" &&
                w.deliveries[subjectId]?.receiver === deviceId),
        );
      const maxSpeed = (request = false) =>
        sample<{ maxSpeed: number }>(
          deviceId + "/drive_state",
          request ? "request" : "run",
        ).maxSpeed;
      const transport = () =>
        sample<TransportObservation>(
          deviceId + "/transport",
          "request_subject",
        );
      const robot = () =>
        sample<RobotObservation>(
          deviceId + "/robot_state",
          b.scope.startsWith("request") ? b.scope : "run",
        );
      const sourceSupported = (w: World) => {
        const src = owner(resolved.source),
          s = load(w),
          support =
            src.contract.device_type === "machine_tool"
              ? src.instance_id + "/support"
              : isCarryingWorkpiece(src.contract)
                ? src.instance_id + "/body"
                : src.instance_id + "/surface";
        return (
          settled(w) &&
          s.supports.includes(support) &&
          [...configs.values()]
            .filter((p) => p.drives.some((d) => d.device === src.instance_id))
            .every((p) => {
              sources.add(p.leader + "/drive_state");
              return (
                sample<{ maxSpeed: number }>(p.leader + "/drive_state")
                  .maxSpeed <= p.speedTolerance
              );
            })
        );
      };
      const destinationFree = (w: World) => {
        const dest = owner(resolved.target),
          support = dest.instance_id + "/surface";
        if (w.machining && compiled.machining) {
          const { machineItem, atStation, slots, pallet } = w.machining;
          const config = compiled.machining,
            item = config.pallets
              .find((p) => p.id === pallet)
              ?.items.find((i) => i.material === subjectId);
          if (!atStation || !item) return false;
          const source = String(resolved.source);
          const target = String(resolved.target);
          const carrier = compiled.devices.get(pallet!)!;
          const occupiesSource = source === config.point
            ? machineItem === subjectId
            : slots[source] === subjectId;
          const available = target === config.point
            ? machineItem === null
            : carrier.locations[target]?.frame === "carrier_local_m" && !slots[target];
          return occupiesSource && available;
        }
        if (w.loading && compiled.loading) {
          const pallet = compiled.loading.pallets.find(
            (p) => p.id === dest.instance_id,
          );
          return (
            !!pallet &&
            w.loading.pallet === pallet.id &&
            pallet.items.some(
              (i) => i.target === resolved.target && i.material === subjectId,
            ) &&
            !Object.hasOwn(w.loading.slots, String(resolved.target)) &&
            maxMainlineSpeed() <=
              configs.get(compiled.loading.exchange.leader)!.speedTolerance
          );
        }
        return !Object.entries(w.bodies).some(
          ([id, s]) =>
            id !== subjectId + "/body" &&
            s.active &&
            s.supports.includes(support),
        );
      };
      const maxMainlineSpeed = () =>
        sample<{ maxSpeed: number }>(
          compiled.loading!.exchange.leader + "/drive_state",
        ).maxSpeed;
      const targetValid = (w: World) => {
        const target = config?.targets.find(
            (t) => t.id === String(resolved.target ?? deviceId + ".exit"),
          ),
          s = load(w);
        if (!config || !target || !supported(w) || !settled(w) || !s.pose)
          return false;
        const sub = [...config.subjects.values()].find(
          (s) => s.id === subjectId,
        );
        if (!sub) return false;
        const point = new Vector3(...sub.referenceOffset)
          .applyQuaternion(new Quaternion(...s.pose.rotation))
          .add(new Vector3(...s.pose.position));
        const direction = new Vector3(...config.drives[0].flow),
          delta = new Vector3(...target.position).sub(point),
          along = delta.dot(direction);
        delta.addScaledVector(direction, -along);
        return (
          along >= -config.positionTolerance &&
          (target.heightMode === "preserve_supported" ||
            (Math.hypot(delta.x, delta.z) <= config.positionTolerance &&
              Math.abs(delta.y) <= config.verticalTolerance))
        );
      };
      switch (name) {
        case "source_pickable":
          return good(
            sourceSupported(world()) &&
              Number(compiled.bodyMap.get(subjectId + "/body")?.mass) <=
                compiled.robots.get(deviceId)!.maxPayload,
          );
        case "target_admissible":
          return good(destinationFree(world()));
        case "pose_plan_valid": {
          const location = owner(resolved.target).locations[
              String(resolved.target)
            ],
            target = location.position,
            base = compiled.robots.get(deviceId)!,
            w = world();
          if (
            (compiled.loading || compiled.machining) &&
            location.reference === "robot_rest_pose"
          ) {
            sources.add("kinematic-preflight/GLB-rest");
            if (!location.rotation_quaternion)
              return fail("location", "Missing rest orientation");
            restJointTarget(base, {
              position: target,
              rotation: location.rotation_quaternion,
            });
            return good(!w.bodies[base.toolBodyId]?.held);
          }
          const previous = c.observations?.samples[deviceId + "/robot_state"];
          const q = previous
            ? sample<RobotObservation>(deviceId + "/robot_state").q
            : Array(6).fill(0);
          sources.add("kinematic-preflight");
          return good(
            !w.bodies[base.toolBodyId]?.held &&
              new CcdPositionIK(new RobotKinematics(base)).solve(
                new Vector3(...target),
                q,
              ).converged,
          );
        }
        case "phase_integrity":
        case "motion_integrity":
          return good(robot().motionIntegrity);
        case "placement_confirmed":
          return good(robot().placementConfirmed);
        case "tcp_position_error_m":
          return good(robot().targetError);
        case "max_joint_speed_rad_s":
          return good(Math.max(...robot().qdot.map(Math.abs)));
        case "requested_orientation_satisfied":
          return good(robot().orientationSatisfied);
        case "target_and_subject_valid":
        case "exit_path_valid":
          return good(targetValid(world()));
        case "subject_admitted":
          return good(supported(world()) && settled(world()));
        case "environment_ready": {
          const w = world(),
            p = compiled.task.pallets.find((p) => p.id === subjectId);
          if (w.machining && compiled.machining)
            return good(
              w.machining.pallet === subjectId &&
                robotsClear(w) &&
                w.receipts.some(
                  (r) =>
                    r.kind === "supply_confirmed" &&
                    r.subjectId === subjectId &&
                    r.runId === c.frame.runId,
                ) &&
                (resolved.target !== compiled.machining.exitTarget ||
                  w.machining.completedLoad),
            );
          if (w.loading && compiled.loading) {
            const admitted = w.receipts.some(
              (r) =>
                r.kind === "supply_confirmed" &&
                r.runId === c.frame.runId &&
                r.subjectId === subjectId,
            );
            if (!admitted || !robotsClear(w)) return good(false);
            if (p)
              return good(
                p.id === w.loading.pallet &&
                  (resolved.target !== compiled.loading.exchange.exit ||
                    compiled.loading.pallets
                      .find((x) => x.id === p.id)!
                      .items.every(
                        (i) => w.loading!.slots[i.target] === i.material,
                      )),
              );
            return good(
              compiled.loading.supplies.some(
                (s) => s.leader === deviceId && s.materials.includes(subjectId),
              ),
            );
          }
          return good(
            !!p &&
              w.receipts.some(
                (r) =>
                  r.runId === c.frame.runId &&
                  r.kind === "supply_confirmed" &&
                  r.subjectId === subjectId,
              ) &&
              robotsClear(w) &&
              (resolved.target !== deviceId + ".exit" ||
                p.items.every((i) =>
                  w.receipts.some(
                    (r) =>
                      r.runId === c.frame.runId &&
                      r.kind === "material_delivered" &&
                      r.subjectId === i.material,
                  ),
                )),
          );
        }
        case "motion_interlocks_clear":
          return good(robotsClear(world()));
        case "transport_integrity": {
          const w = world(),
            t = transport(),
            s = load(w);
          const validSubject =
            t.subject === subjectId &&
            t.target === String(args.target ?? deviceId + ".exit");
          const released =
            c.requestState?.outcome === "succeeded" &&
            w.receipts.some(
              (r) =>
                r.runId === c.frame.runId &&
                r.kind === "carrier_departed" &&
                r.subjectId === subjectId,
            );
          return good(
            validSubject &&
              (s.active ? supported(w) : released) &&
              (config!.drives.length === 1 || robotsClear(w)),
          );
        }
        case "target_error_m":
          return good(transport().distance);
        case "target_supported":
          return good(transport().supported);
        case "subject_and_drives_stationary":
          return good(transport().stationary);
        case "path_unblocked": {
          const w = world();
          return good(
            Object.entries(w.bodies).filter(
              ([id, s]) =>
                id !== subjectId + "/body" &&
                s.active &&
                s.supports.some((x) =>
                  config!.drives.some((d) => d.surfaceId === x),
                ),
            ).length === 0,
          );
        }
        case "subject_at_exit": {
          const w = world(),
            s = load(w),
            target = config!.targets.find((t) => t.id === deviceId + ".exit")!;
          if (w.machining)
            return good(
              w.machining.pallet === subjectId && w.machining.fullAtExit,
            );
          if (w.loading)
            return good(w.loading.pallet === subjectId && w.loading.fullAtExit);
          return good(
            supported(w) &&
              settled(w) &&
              Math.abs(s.pose!.position[0] - target.position[0]) <=
                config!.positionTolerance,
          );
        }
        case "receiver_admissible": {
          const w = world();
          if (w.machining)
            return good(
              w.machining.pallet === subjectId &&
                w.machining.fullAtExit &&
                !receipt(w),
            );
          if (w.loading)
            return good(
              w.loading.pallet === subjectId &&
                w.loading.fullAtExit &&
                !receipt(w),
            );
          return good(
            compiled.outfeeds.includes(deviceId) &&
              compiled.goals.material_ids.includes(subjectId) &&
              !receipt(w) &&
              settled(w),
          );
        }
        case "release_history_exists":
        case "elapsed_since_release_s": {
          const w = world(),
            receipts = w.receipts.filter(
              (r) =>
                r.runId === c.frame.runId &&
                (w.loading || w.machining
                  ? r.kind === "carrier_departed" &&
                    (compiled.loading?.exchange.leader ??
                      compiled.machining?.leader) === deviceId
                  : r.kind === "material_delivered" &&
                    w.deliveries[r.subjectId]?.receiver === deviceId),
            );
          return good(
            name === "release_history_exists"
              ? receipts.length > 0
              : receipts.length
                ? (c.frame.tick - Math.max(...receipts.map((r) => r.tick))) / 60
                : null,
            "successful receiver receipts",
          );
        }
        case "handoff_ownership_valid": {
          const w = world();
          return good(
            granted() &&
              (!!receipt(w) || supported(w)) &&
              c.requestState?.accepted === true,
          );
        }
        case "receiver_receipt":
          return good(!!receipt(world()));
        case "subject_on_device":
          return good(supported(world()));
        case "already_stationary":
          return good(maxSpeed() <= config!.speedTolerance);
        case "controlled_stop_supported":
          sources.add("registered drive configuration");
          return good(
            !!config &&
              Number.isFinite(config.deceleration) &&
              config.deceleration > 0,
          );
        case "load_tracking_available":
        case "stop_retains_loads": {
          const w = world();
          return good(
            [...config!.subjects.values()].every((s) => {
              const b = w.bodies[s.bodyId];
              return (
                !!b &&
                (b.active
                  ? !!b.pose && b.pose.position.every(Number.isFinite)
                  : w.receipts.some(
                      (r) =>
                        r.runId === c.frame.runId &&
                        r.subjectId === s.id &&
                        ["material_delivered", "carrier_departed"].includes(
                          r.kind,
                        ),
                    ) ||
                    ((w.loading || w.machining) &&
                      w.receipts.some(
                        (r) =>
                          r.kind === "carrier_departed" &&
                          r.bodyIds.includes(s.bodyId),
                      )) ||
                    compiled.devices.get(s.id)?.creation_policy ===
                      "clone_on_admission")
              );
            }),
          );
        }
        case "max_drive_speed_mps":
          return good(maxSpeed(true));
        default:
          return fail(b.provider, "unimplemented condition binding");
      }
    } catch (e) {
      if (e instanceof MissingEvidence) return e.reading;
      return {
        value: null,
        quality: "invalid",
        sampledTick,
        source: [...sources].join(" + "),
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  };
}

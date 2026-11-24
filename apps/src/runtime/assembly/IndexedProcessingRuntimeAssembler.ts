/** 将人工搬运、转台分度和机器人加工绑定到同一场景，管理逐件供收料，并依据分度角、加工记录与交付顺序验收工单。 */

import { getDeviceModule } from "@/devices/registry";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import type { ActionBinding, ActionRequest } from "@/contracts/scheduler";
import type {
  ConditionContext,
  ObservationWrite,
} from "@/contracts/conditions";
import {
  bindDeviceBehavior,
  signalLayoutFromContract,
} from "@/domain/runtime/bindDeviceBehavior";
import { bindProcess } from "@/domain/runtime/bindProcess";
import { compileConditions } from "@/domain/runtime/compileConditions";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import { SceneRuntimeProgram } from "@/runtime/engine/SceneRuntimeProgram";
import { createJoltBackend } from "@/runtime/physics/jolt/JoltPhysicsBackend";
import {
  IndexedFixtureBindings,
  requestFields,
} from "./indexedFixtureBindings";
import {
  ConditionProviders,
  ObservationRegistry,
  SignalRegistry,
} from "@/runtime/signals";
import { ConditionTrace } from "@/runtime/signals/ConditionTrace";

type MotionState = ReturnType<IndexedFixtureBindings["snapshot"]>;
export interface CellState extends MotionState {
  active: string | null;
  onSource: boolean;
  delivered: { material: string; target: string; tick: number }[];
}
function requestedAngle(r: ActionRequest) {
  return (r.arguments.angleTag as { value: number; unit: string } | undefined)
    ?.value;
}
function moduloAngle(angle: number) {
  return ((angle % 360) + 360) % 360;
}

export async function assembleIndexedProcessingRuntime(
  sceneId: string,
  runId: string,
  compiled: CompiledSceneRuntime,
) {
  const cfg = compiled.indexedProcessing!;
  const physics = await createJoltBackend(compiled.physics);
  try {
    const motion = new IndexedFixtureBindings(compiled, physics);
    const { human, table, robot } = cfg;
    const sourceLocations = new Set(
      Object.keys(compiled.devices.get(cfg.source)!.locations),
    );
    let cursor = 0,
      closing = false;
    const delivered: CellState["delivered"] = [];
    const current = () => cfg.jobs[cursor];
    const body = (id: string) => compiled.bodyMap.get(id + "/body")!;
    const angleTolerance = Number(
      compiled.devices.get(table)!.parameters.angle_tolerance_deg,
    );
    const atAngle = (angle: number, target: number) =>
      Math.abs(moduloAngle(angle - target + 180) - 180) <= angleTolerance;
    const signals = new SignalRegistry(
      runId,
      [...compiled.devices.values()]
        .filter((d) => !d.asset_kind?.endsWith("_prefab"))
        .flatMap((d) =>
          signalLayoutFromContract(sceneId, d.instance_id, d.contract),
        ),
    );
    const actors = [
      getDeviceModule("human_operator").createDriver(
        sceneId,
        runId,
        human,
        (request) => motion.carry(request),
        () => motion.stopped(human),
        () => !!motion.snapshot().holding,
      ),
      getDeviceModule("rotary_table").createDriver(
        sceneId,
        runId,
        table,
        (request) => motion.index(request),
        () => motion.stopped(table),
        () => {
          const state = motion.snapshot();
          return {
            angle: state.measuredAngleDeg,
            occupied: !!state.tableMaterial,
          };
        },
        cfg.indexing.stations,
        angleTolerance,
      ),
      getDeviceModule("robot_arm").createProcessingDriver(
        sceneId,
        runId,
        robot,
        (request) => motion.process(request),
        () => motion.stopped(robot),
      ),
    ];
    const supply = getDeviceModule("material_source_station").createSupply(
      physics,
    );
    // The palm and torch are physical tracking points even when their GLB
    // meshes are animated through the character and robot hierarchies.
    const movingBodies = [...compiled.bodyMap.values()].filter(
      (body) => body.motionType !== "static",
    );
    let pending: ObservationWrite[] = [];
    const environment: DeviceActionPort = {
      id: "@indexed-cell",
      supports: () => false,
      prepare() {
        throw new Error("Environment has no callable behaviors");
      },
      submit() {
        throw new Error("Environment has no callable behaviors");
      },
      cancel() {},
      prepareCancel: () => [],
      prepareStop: () => [],
      requestStop() {
        closing = true;
      },
      isStopped: () => !motion.snapshot().holding && physics.isMotionStopped!(),
      dispose() {},
      beforePhysics() {
        const job = current();
        if (!closing && job && !physics.isBodyActive!(body(job.material).id)) {
          const b = body(job.material);
          supply.presentAtRest([b]);
        }
      },
      afterPhysics(_dt, tick) {
        const m = motion.snapshot(),
          job = current();
        if (
          !closing &&
          job &&
          m.transfers.some(
            (r) => r.material === job.material && r.target === job.target,
          ) &&
          m.humanHome &&
          m.robotHome &&
          !m.holding &&
          !m.tableMaterial &&
          motion.supportedAt(job.material, job.target)
        ) {
          physics.deactivateBodies!([body(job.material).id]);
          delivered.push({ material: job.material, target: job.target, tick });
          cursor++;
        }
        const active = current()?.material ?? null;
        const value: CellState = {
          ...m,
          active,
          onSource: !!active && motion.supportedAt(active, current()!.input),
          delivered,
        };
        const bodies = Object.fromEntries(
          movingBodies.map((b) => {
            const active = physics.isBodyActive!(b.id);
            return [
              b.id,
              {
                active,
                pose: active ? physics.readBody!(b.id) : undefined,
                materialState: cfg.materialFrames.has(b.instanceId)
                  ? m.operations.some((op) => op.material === b.instanceId)
                    ? "finished"
                    : "raw"
                  : undefined,
              },
            ];
          }),
        );
        pending = [
          { key: "indexing/state", provider: "physics", runId, value },
          { key: "world/state", provider: "physics", runId, value: { bodies } },
          {
            key: robot + "/robot_state",
            provider: "physics",
            runId,
            value: { q: m.q, qdot: m.qdot, holding: false },
          },
        ];
      },
      drainSignals: () => [],
      drainFeedback: () => [],
      drainObservations() {
        const obs = pending;
        pending = [];
        return obs;
      },
    };
    const drivers: DeviceActionPort[] = [...actors, environment];
    const observations = new ObservationRegistry(
      runId,
      ["indexing/state", "world/state", robot + "/robot_state"].map((key) => ({
        key,
        provider: "physics",
        maxAgeTicks: 1,
        validate: (v) => v !== null && typeof v === "object",
      })),
    );
    const state = (c: ConditionContext) => {
      const s = c.observations?.samples["indexing/state"];
      return s?.quality === "good" && s.runId === runId
        ? (s.value as CellState)
        : undefined;
    };
    const actions: ActionBinding[] = [];
    const providers = new ConditionProviders(new ConditionTrace("expression"));
    const resources = (r: ActionRequest, w: CellState) => {
      const material = requestFields(r).material ?? w.tableMaterial;
      return [
        "device/" + human,
        "device/" + table,
        "device/" + robot,
        "location/" + cfg.slot,
        ...(material ? ["subject/" + material] : []),
      ];
    };
    const ready = (r: ActionRequest, w: CellState) => {
      const p = requestFields(r),
        active = w.active;
      if (
        !active ||
        !w.humanHome ||
        !w.robotHome ||
        w.holding ||
        !w.stopped[table]
      )
        return false;
      // The DSL orders work. Admission depends only on the request, occupancy and physical docks.
      if (r.device === table) return w.tableMaterial === active && w.retained;
      if (p.material !== active) return false;
      if (r.device === robot)
        return (
          w.tableMaterial === active &&
          w.retained &&
          !w.operations.some((op) => op.material === active) &&
          atAngle(w.measuredAngleDeg, cfg.indexing.process)
        );
      if (!atAngle(w.measuredAngleDeg, cfg.indexing.home)) return false;
      return p.source === cfg.slot
        ? w.tableMaterial === active && w.retained
        : w.onSource && !w.tableMaterial;
    };
    const complete = (r: ActionRequest, w: CellState) => {
      const p = requestFields(r);
      if (r.device === table)
        return (
          w.stopped[table] &&
          w.rotations.some(
            (x) =>
              x.request === r.requestId &&
              atAngle(x.measuredAngleDeg, requestedAngle(r)!),
          )
        );
      if (r.device === robot)
        return (
          w.robotHome &&
          w.operations.some(
            (x) => x.request === r.requestId && x.material === p.material,
          )
        );
      return (
        w.humanHome &&
        !w.holding &&
        w.transfers.some(
          (x) =>
            x.request === r.requestId &&
            x.material === p.material &&
            x.source === p.source &&
            x.target === p.target,
        )
      );
    };
    for (const actor of actors) {
      const device = actor.id;
      const d = compiled.devices.get(device)!;
      const behavior =
        device === human
          ? "carry_material"
          : device === table
            ? "rotate_to_station"
            : "process_material";
      const expected = {
        precondition: "ready",
        authorization: "authorized",
        sustaining: "sustaining",
        completion: "completion",
      };
      for (const rule of compileConditions(device, d.contract, behavior)) {
        if (
          rule.expr.op !== "opaque" ||
          rule.expr.key !==
            behavior + "." + expected[rule.phase as keyof typeof expected]
        )
          throw new Error("Unsupported indexed-cell condition: " + rule.key);
        providers.registerExpression(
          rule,
          () => {
            throw new Error("Unexpected native condition leaf");
          },
          (c) => {
            const w = state(c),
              r = c.request as ActionRequest | undefined;
            if (!w || !r) return undefined;
            if (rule.phase === "precondition") return ready(r, w);
            if (rule.phase === "authorization")
              return ready(r, w) && resources(r, w).every((k) => c.owns(k));
            if (rule.phase === "completion")
              return c.requestState?.outcome === "succeeded" && complete(r, w);
            const fault = c.frame.samples[sceneId + "/" + device + "/error"];
            if (fault?.quality !== "good" || fault.value !== false)
              return false;
            if (device === human) return w.robotHome && w.stopped[table];
            if (device === table)
              return w.humanHome && w.robotHome && w.retained;
            return (
              w.humanHome &&
              w.stopped[table] &&
              w.tableMaterial === requestFields(r).material &&
              w.retained
            );
          },
        );
      }
      const stopped = device + "/" + behavior + ".stopped";
      providers.register(stopped, {
        evaluate: (c) => state(c)?.stopped[device],
      });
      actions.push(
        bindDeviceBehavior(device, d.contract, behavior, {
          contractVersion: String(d.contract.version),
          parameters: d.parameters,
          stopped: [stopped],
          resources: (c) => resources(c.request as ActionRequest, state(c)!),
          validatePayload: (payload) => {
            if (device === table) {
              if (payload !== undefined)
                throw new Error("Index action takes an angle");
              return;
            }
            const v = payload as
                | { binding?: string; fields?: Record<string, string> }
                | undefined,
              p = v?.fields;
            if (v?.binding !== device + "." + behavior || !p)
              throw new Error("Unbound cell action payload");
            const frames = cfg.materialFrames.get(p.material);
            if (!frames) throw new Error("Unknown workpiece " + p.material);
            if (device === robot) {
              if (
                Object.keys(p).length !== 4 ||
                p.station !== cfg.slot ||
                p.tool !== cfg.toolInterface ||
                p.process !== frames.processInterface
              )
                throw new Error("Invalid processing interface pair");
            } else if (
              Object.keys(p).length !== 4 ||
              p.grasp !== frames.graspInterface ||
              !(
                (sourceLocations.has(p.source) && p.target === cfg.slot) ||
                (p.source === cfg.slot && sourceLocations.has(p.target))
              )
            )
              throw new Error("Invalid carry route");
          },
        }),
      );
    }
    const goal = "indexed-cell/processed-and-delivered";
    providers.register(goal, {
      evaluate: (c) => {
        const w = state(c);
        return (
          w &&
          !w.active &&
          !w.holding &&
          !w.tableMaterial &&
          w.humanHome &&
          w.robotHome &&
          w.stopped[table] &&
          cfg.jobs.every((j) => {
            const ops = w.operations.filter((op) => op.material === j.material);
            const receipts = w.delivered.filter(
              (r) => r.material === j.material && r.target === j.target,
            );
            const op = ops[0];
            return (
              ops.length === 1 &&
              receipts.length === 1 &&
              op.robot === robot &&
              op.recipe === cfg.recipe &&
              op.station === cfg.slot &&
              op.tool === cfg.toolInterface &&
              op.process ===
                cfg.materialFrames.get(j.material)!.processInterface &&
              op.tick <= receipts[0].tick
            );
          })
        );
      },
    });
    const scope: Record<string, unknown> = { task: compiled.task };
    for (const d of compiled.devices.values()) {
      scope[d.instance_id] = d.instance_id;
      for (const k of Object.keys(d.locations)) scope[k] = k;
    }
    const process = bindProcess(compiled.root, {
      actions,
      providers,
      scope,
      finalization: [goal],
    });
    const present = () => {
      const job = current();
      return job && motion.supportedAt(job.material, job.input);
    };
    for (let i = 0; i < 120 && !present(); i++) {
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
    if (!present())
      throw new Error("Initial S11 workpiece lacks stable cart support");
    return {
      compiled,
      program: new SceneRuntimeProgram(
        sceneId,
        runId,
        process,
        signals,
        physics,
        drivers,
        observations,
      ),
    };
  } catch (error) {
    physics.dispose();
    throw error;
  }
}

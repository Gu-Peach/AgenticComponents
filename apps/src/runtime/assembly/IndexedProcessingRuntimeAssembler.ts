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
import { IndexingCellMotion } from "@/runtime/services/IndexingCellMotion";
import {
  ConditionProviders,
  ObservationRegistry,
  SignalRegistry,
} from "@/runtime/signals";
import { ConditionTrace } from "@/runtime/signals/ConditionTrace";

type MotionState = ReturnType<IndexingCellMotion["snapshot"]>;
interface CellState extends MotionState {
  active: string | null;
  onSource: boolean;
  delivered: { material: string; target: string; tick: number }[];
}
function fields(r: ActionRequest) {
  return (
    (r.payload as { fields?: Record<string, string> } | undefined)?.fields ?? {}
  );
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
    const motion = new IndexingCellMotion(compiled, physics);
    const { human, table, robot } = cfg;
    let cursor = 0,
      closing = false;
    const delivered: CellState["delivered"] = [];
    const current = () => cfg.jobs[cursor];
    const body = (id: string) => compiled.bodyMap.get(id + "/body")!;
    const onSource = (id: string) => {
      const b = body(id);
      if (
        !physics.isBodyActive!(b.id) ||
        physics.hasGraspForBody!(b.id) ||
        !physics.hasContactSupport!(b.id, cfg.sourceBody)
      )
        return false;
      const pose = physics.readBody!(b.id);
      return (
        Math.hypot(...pose.velocity) < 0.03 &&
        Math.hypot(...(pose.angularVelocity ?? [])) < 0.1
      );
    };
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
    const plan = (request: ActionRequest) => motion.job(request);
    const actors = [
      getDeviceModule("human_operator").createDriver(
        sceneId,
        runId,
        human,
        plan,
        () => motion.stopped(human),
        () => !!motion.snapshot().holding,
      ),
      getDeviceModule("rotary_table").createDriver(
        sceneId,
        runId,
        table,
        plan,
        () => motion.stopped(table),
        () => {
          const state = motion.snapshot();
          return {
            angle: state.measuredAngleDeg,
            occupied: !!state.tableMaterial,
          };
        },
        [0, 180],
        angleTolerance,
      ),
      getDeviceModule("robot_arm").createProcessingDriver(
        sceneId,
        runId,
        robot,
        plan,
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
          onSource(job.material) &&
          m.operations.some((op) => op.material === job.material)
        ) {
          physics.deactivateBodies!([body(job.material).id]);
          delivered.push({ material: job.material, target: job.target, tick });
          cursor++;
        }
        const active = current()?.material ?? null;
        const value: CellState = {
          ...m,
          active,
          onSource: !!active && onSource(active),
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
      const material = fields(r).material ?? w.tableMaterial;
      return [
        "device/" + human,
        "device/" + table,
        "device/" + robot,
        "location/" + cfg.slot,
        ...(material ? ["subject/" + material] : []),
      ];
    };
    const ready = (r: ActionRequest, w: CellState) => {
      const p = fields(r),
        active = w.active;
      if (
        !active ||
        !w.humanHome ||
        !w.robotHome ||
        w.holding ||
        !w.stopped[table]
      )
        return false;
      const rotations = w.rotations.filter((x) => x.material === active).length;
      const processed = w.operations.some((op) => op.material === active);
      if (r.device === table) {
        return (
          w.tableMaterial === active &&
          ((requestedAngle(r) === 180 &&
            rotations === 0 &&
            !processed &&
            atAngle(w.measuredAngleDeg, 0)) ||
            (requestedAngle(r) === 0 &&
              rotations === 1 &&
              processed &&
              atAngle(w.measuredAngleDeg, 180)))
        );
      }
      if (p.material !== active) return false;
      if (r.device === robot)
        return (
          w.tableMaterial === active &&
          rotations === 1 &&
          !processed &&
          atAngle(w.measuredAngleDeg, 180)
        );
      if (!atAngle(w.measuredAngleDeg, 0)) return false;
      return p.target === cfg.slot
        ? w.onSource && !w.tableMaterial && rotations === 0 && !processed
        : w.tableMaterial === active && rotations === 2 && processed;
    };
    const complete = (r: ActionRequest, w: CellState) => {
      const p = fields(r);
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
              return w.humanHome && w.robotHome && !!w.tableMaterial;
            return (
              w.humanHome &&
              w.stopped[table] &&
              w.tableMaterial === fields(r).material
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
            const job = cfg.jobs.find((j) => j.material === p.material),
              frames = cfg.materialFrames.get(p.material);
            if (!job || !frames)
              throw new Error("Unknown workpiece " + p.material);
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
                (p.source === job.input && p.target === cfg.slot) ||
                (p.source === cfg.slot && p.target === job.target)
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
          atAngle(w.measuredAngleDeg, 0) &&
          cfg.jobs.every((j) => {
            const operations = w.operations.filter(
              (op) => op.material === j.material,
            );
            const turns = w.rotations.filter((r) => r.material === j.material);
            const carries = w.transfers.filter(
              (r) => r.material === j.material,
            );
            const receipts = w.delivered.filter(
              (r) => r.material === j.material && r.target === j.target,
            );
            if (
              operations.length !== 1 ||
              turns.length !== 2 ||
              carries.length !== 2 ||
              receipts.length !== 1
            )
              return false;
            const [op] = operations;
            return (
              op.robot === robot &&
              op.recipe === cfg.recipe &&
              op.station === cfg.slot &&
              op.tool === cfg.toolInterface &&
              op.process ===
                cfg.materialFrames.get(j.material)!.processInterface &&
              carries[0].source === j.input &&
              carries[0].target === cfg.slot &&
              carries[1].source === cfg.slot &&
              carries[1].target === j.target &&
              atAngle(turns[0].measuredAngleDeg, 180) &&
              atAngle(turns[1].measuredAngleDeg, 0) &&
              turns.every(
                (t) => Math.abs(t.toDeg - t.fromDeg - 180) <= angleTolerance,
              ) &&
              carries[0].tick < turns[0].tick &&
              turns[0].tick < op.startTick &&
              op.tick < turns[1].tick &&
              turns[1].tick < carries[1].tick &&
              carries[1].tick <= receipts[0].tick
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
    const present = () => current() && onSource(current().material);
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

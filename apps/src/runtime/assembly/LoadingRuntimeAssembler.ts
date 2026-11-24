/** 装配托盘装载与逐件加工场景，将输送带、机械臂和可选机床接入调度器，并绑定工位互锁、放置回执与整盘离场条件。 */

import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import type { ActionBinding, ActionRequest } from "@/contracts/scheduler";
import type {
  ConditionContext,
  ObservationDefinition,
} from "@/contracts/conditions";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import { compileConditions } from "@/domain/runtime/compileConditions";
import {
  bindDeviceBehavior,
  signalLayoutFromContract,
} from "@/domain/runtime/bindDeviceBehavior";
import { bindProcess } from "@/domain/runtime/bindProcess";
import { SceneRuntimeProgram } from "@/runtime/engine/SceneRuntimeProgram";
import { createJoltBackend } from "@/runtime/physics/jolt/JoltPhysicsBackend";
import {
  ConditionProviders,
  ObservationRegistry,
  SignalRegistry,
} from "@/runtime/signals";
import { ConditionTrace } from "@/runtime/signals/ConditionTrace";
import { LoadingLineEnvironment } from "@/runtime/services/LoadingLineEnvironment";
import { MachiningLineEnvironment } from "@/runtime/services/MachiningLineEnvironment";
import { MachineToolAdapter } from "@/runtime/adapters/scene/MachineToolAdapter";
import {
  createMachiningDevices,
  fitsMachiningLocation,
} from "./machiningDevices";
import {
  sceneConditionReader,
  supportsSceneConditionBinding,
  type SceneConditionWorld,
} from "./SceneConditionBindings";
import { createLoadingDevices, fitsLoadedSlot } from "./loadingDevices";

/** Attach a placement receipt only to the physical driver result that produced it. */
function trackPlacements(
  driver: DeviceActionPort,
  record: (r: ActionRequest) => void,
): DeviceActionPort {
  let active: ActionRequest | undefined;
  return {
    id: driver.id,
    supports: (b) => driver.supports(b),
    prepare: (r, f) => driver.prepare(r, f),
    prepareCancel: (r, f) => driver.prepareCancel(r, f),
    prepareStop: (f) => driver.prepareStop(f),
    submit: (r) => {
      driver.submit(r);
      active = r;
    },
    cancel: (r) => driver.cancel(r),
    acknowledge: (a, f) => driver.acknowledge?.(a, f) ?? [],
    requestStop: () => driver.requestStop(),
    isStopped: () => driver.isStopped(),
    dispose: (reason) => driver.dispose(reason),
    beforePhysics: (dt, t) => driver.beforePhysics(dt, t),
    afterPhysics: (dt, t) => driver.afterPhysics(dt, t),
    drainSignals: () => driver.drainSignals(),
    drainObservations: () => driver.drainObservations?.() ?? [],
    drainFeedback: () => {
      const feedback = driver.drainFeedback();
      for (const f of feedback)
        if (
          f.status === "succeeded" &&
          active?.requestId === f.requestId &&
          active.runId === f.runId &&
          active.activationId === f.activationId
        ) {
          record(active);
          active = undefined;
        }
      return feedback;
    },
  };
}

export async function assembleLoadingRuntime(
  sceneId: string,
  runId: string,
  compiled: CompiledSceneRuntime,
) {
  const loading = compiled.loading,
    machining = compiled.machining;
  const physics = await createJoltBackend(compiled.physics);
  try {
    const devices = (machining ? createMachiningDevices : createLoadingDevices)(
      sceneId,
      runId,
      compiled,
      physics,
      {
        releasePallet: (id, target, tick) =>
          environment.releasePallet(id, target, tick),
      },
    );
    const environment: LoadingLineEnvironment | MachiningLineEnvironment = machining
      ? new MachiningLineEnvironment(
          runId,
          compiled,
          physics,
          devices.configs.get(machining.leader)!,
          (id, target) => fitsMachiningLocation(compiled, physics, id, target),
          () => devices.robots.get(machining.robot)!.isStopped(),
        )
      : new LoadingLineEnvironment(
          runId,
          compiled,
          physics,
          devices.configs,
          (id) => fitsLoadedSlot(compiled, physics, id),
        );
    const machiningSlots = new Map(
      machining?.pallets.flatMap((p) =>
        p.items.map((i) => [i.material, i.source] as const),
      ),
    );
    const materialByNumber = new Map(
      [...compiled.subjectIds].map(([id, number]) => [number, id]),
    );
    const subject = (args: Readonly<Record<string, unknown>>) =>
      materialByNumber.get(Number(args.subject_id)) ?? "";
    const machineDriver =
      machining && environment instanceof MachiningLineEnvironment
        ? new MachineToolAdapter(
            machining.machine,
            sceneId,
            runId,
            machining.cycleTicks,
            (r) => subject(r.arguments),
            environment,
          )
        : undefined;
    const drivers: DeviceActionPort[] = [
      ...devices.drivers.map((d) =>
        compiled.robots.has(d.id)
          ? trackPlacements(d, (r) => environment.recordPlacement(r))
          : d,
      ),
      ...(machineDriver ? [machineDriver] : []),
      environment,
    ];
    const signals = new SignalRegistry(
      runId,
      [...compiled.devices.values()]
        .filter((d) => !d.asset_kind?.endsWith("_prefab"))
        .flatMap((d) =>
          signalLayoutFromContract(sceneId, d.instance_id, d.contract),
        ),
    );
    const definitions: ObservationDefinition[] = [];
    const observe = (key: string, provider: string) =>
      definitions.push({
        key,
        provider,
        maxAgeTicks: 1,
        validate: (v) => v !== null && typeof v === "object",
      });
    for (const id of devices.configs.keys())
      for (const suffix of ["loads", "transport", "drive_state"])
        observe(id + "/" + suffix, "adapter:" + id);
    for (const id of compiled.robots.keys())
      observe(id + "/robot_state", "adapter:" + id);
    observe("world/state", "physics");
    const observations = new ObservationRegistry(runId, definitions);
    const providers = new ConditionProviders(new ConditionTrace("expression"));
    const actions: ActionBinding[] = [];
    const materialTargets = new Map(
      loading?.pallets.flatMap((p) =>
        p.items.map((i) => [i.material, i.target] as const),
      ),
    );
    const slotOwners = new Map(
      loading?.pallets.flatMap((p) =>
        p.items.map((i) => [i.target, p.id] as const),
      ),
    );
    const registered = new Set<string>();
    for (const { device, behavior } of compiled.bundle.calls) {
      if (actions.some((a) => a.device === device && a.behavior === behavior))
        continue;
      const d = compiled.devices.get(device)!;
      const adapter = drivers.find((a) => a.id === device);
      if (!adapter?.supports(behavior))
        throw new Error("No loading adapter for " + device + "." + behavior);
      const reader = sceneConditionReader(
        sceneId,
        device,
        compiled,
        devices.configs,
        actions,
      );
      for (const rule of compileConditions(device, d.contract, behavior)) {
        if (
          machining &&
          device === machining.machine &&
          rule.expr.op === "opaque"
        ) {
          const key = rule.expr.key;
          if (
            ![
              "machine_material.ready",
              "machine_material.authorized",
              "machine_material.sustaining",
              "machine_material.completion",
            ].includes(key)
          )
            throw new Error("Unknown machine condition: " + key);
          providers.registerExpression(rule, reader, (c) => {
            const sample = c.observations?.samples["world/state"];
            if (
              sample?.quality !== "good" ||
              sample.runId !== runId ||
              !c.request
            )
              return undefined;
            const w = sample.value as SceneConditionWorld,
              m = w.machining!;
            const id = subject(c.scope.arguments as Record<string, unknown>);
            const held =
              m.machineItem === id &&
              m.workSupported &&
              w.robotClear[machining.robot] &&
              m.atStation;
            const complete =
              m.operations.some(
                (o) => o.material === id && o.request === c.request!.requestId,
              ) && w.bodies[id + "/body"]?.materialState === "finished";
            if (key === "machine_material.completion")
              return (
                held && complete && c.requestState?.outcome === "succeeded"
              );
            if (key === "machine_material.sustaining")
              return (
                held &&
                (w.bodies[id + "/body"]?.materialState === "raw" || complete)
              );
            const ready =
              held && w.bodies[id + "/body"]?.materialState === "raw";
            return key === "machine_material.ready"
              ? ready
              : ready &&
                  [
                    "device/" + device,
                    "subject/" + id,
                    "location/" + machining.point,
                    "device/" + machining.robot,
                  ].every((k) => c.owns(k));
          });
          continue;
        }
        if (
          rule.expr.op === "opaque" ||
          Object.values(rule.bindings).some(
            (b) => !supportsSceneConditionBinding(b, d.contract.device_type),
          )
        )
          throw new Error("Unsupported loading condition: " + rule.key);
        if (!registered.has(rule.key)) {
          providers.registerExpression(rule, reader);
          registered.add(rule.key);
        }
      }
      const stopped = device + "/loading.stopped";
      if (!registered.has(stopped)) {
        providers.register(stopped, {
          evaluate: (c) => {
            if (device === machining?.machine) {
              const busy = c.frame.samples[sceneId + "/" + device + "/busy"];
              return busy?.quality === "good"
                ? busy.value === false
                : undefined;
            }
            const output =
              c.frame.samples[sceneId + "/" + device + "/actual_speed"];
            if (devices.configs.has(device))
              return (
                output?.quality === "good" &&
                Math.abs(Number(output.value)) <=
                  devices.configs.get(device)!.speedTolerance
              );
            const robot = c.observations?.samples[device + "/robot_state"];
            if (robot?.quality !== "good" || robot.runId !== runId)
              return undefined;
            const state = robot.value as { qdot: number[]; holding: boolean };
            return (
              !state.holding &&
              state.qdot.every(
                (v) => Math.abs(v) <= compiled.robots.get(device)!.settleSpeed,
              )
            );
          },
        });
        registered.add(stopped);
      }
      actions.push(
        bindDeviceBehavior(device, d.contract, behavior, {
          contractVersion: String(d.contract.version),
          parameters: d.parameters,
          stopped: [stopped],
          resources: (c, args) => {
            if (machining && device === machining.machine)
              return [
                "subject/" + subject(args),
                "location/" + machining.point,
                "device/" + machining.robot,
              ];
            const config = devices.configs.get(device);
            if (config) {
              const subject = config.subjects.get(Number(args.subject_id));
              return [
                ...config.drives.map((d) => "device/" + d.device),
                ...(subject ? ["subject/" + subject.id] : []),
              ];
            }
            const f = (c.scope.payload as { fields: Record<string, string> })
              .fields;
            if (!f.material) return [];
            if (machining)
              return [
                "subject/" + f.material,
                "location/" + machining.point,
                "location/" + machiningSlots.get(f.material),
                "device/" + machining.machine,
                "device/" + machining.leader,
              ];
            const line = loading!.supplies.find(
              (s) => s.device === loading!.materialSupply.get(f.material),
            )!;
            return [
              "subject/" + f.material,
              "subject/" + slotOwners.get(f.target),
              "location/" + f.target,
              "device/" + line.leader,
              "device/" + loading!.exchange.leader,
            ];
          },
          validatePayload: (p) => {
            if (!compiled.robots.has(device)) {
              if (p !== undefined)
                throw new Error("Conveyor accepts scalar arguments");
              return;
            }
            const payload = p as
              { binding?: string; fields?: Record<string, string> } | undefined;
            if (payload?.binding !== device + "." + behavior || !payload.fields)
              throw new Error("Invalid loading robot payload");
            const f = payload.fields;
            if (behavior === "move_to_pose") {
              if (Object.keys(f).length !== 1 || !d.locations[f.target])
                throw new Error("Unknown robot retreat target");
              return;
            }
            if (machining) {
              const slot = machiningSlots.get(f.material);
              if (
                Object.keys(f).length !== 3 ||
                !slot ||
                !(
                  (f.source === slot && f.target === machining.point) ||
                  (f.source === machining.point && f.target === slot)
                )
              )
                throw new Error(
                  "Machining transfer differs from the declared slot: " +
                    f.material,
                );
              return;
            }
            const line = loading!.supplies.find(
              (s) => s.device === loading!.materialSupply.get(f.material),
            );
            if (
              Object.keys(f).length !== 3 ||
              !line ||
              materialTargets.get(f.material) !== f.target ||
              !devices.configs
                .get(line.leader)
                ?.targets.some((t) => t.id === f.source)
            )
              throw new Error(
                "Pick/place payload differs from the finite loading manifest",
              );
          },
        }),
      );
    }
    const complete = (c: ConditionContext) => {
      const sample = c.observations?.samples["world/state"];
      if (sample?.quality !== "good" || sample.runId !== runId)
        return undefined;
      const w = sample.value as SceneConditionWorld;
      return (
        (machining ? w.machining?.pallet : w.loading?.pallet) === null &&
        Object.values(w.robotClear).every(Boolean) &&
        [...devices.configs.values()].every((config) =>
          config.drives.every(
            (d) =>
              c.frame.samples[sceneId + "/" + d.device + "/runningTag"]
                ?.value === false,
          ),
        ) &&
        (loading?.pallets ?? machining!.pallets).every(
          (p) =>
            w.receipts.some(
              (r) =>
                r.kind === "carrier_departed" &&
                r.runId === runId &&
                r.subjectId === p.id,
            ) &&
            p.items.every(
              (i) =>
                ("target" in i
                  ? w.loading?.slots[i.target] === i.material
                  : w.machining?.slots[i.source] === i.material &&
                    w.bodies[i.material + "/body"].materialState ===
                      "finished" &&
                    w.machining.operations.filter(
                      (o) => o.material === i.material,
                    ).length === 1) && !w.bodies[i.material + "/body"].active,
            ),
        )
      );
    };
    const goal = machining
      ? "goal/machined-and-returned"
      : "goal/loaded-and-departed";
    providers.register(goal, { evaluate: complete });
    const scope: Record<string, unknown> = { task: compiled.task };
    for (const d of compiled.devices.values()) {
      scope[d.instance_id] = d.instance_id;
      for (const key of Object.keys(d.locations)) scope[key] = key;
    }
    const process = bindProcess(compiled.root, {
      scope,
      actions,
      providers,
      finalization: [goal],
      readers: {
        subject_id: (args) => {
          const n = compiled.subjectIds.get(String(args[0]));
          if (!n) throw new Error("Unknown loading subject: " + args[0]);
          return n;
        },
      },
    });
    // Establish actual initial support contacts before the first DSL action.
    for (let n = 0; n < 120 && !environment.initialStable; n++) {
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
    if (!environment.initialStable)
      throw new Error(
        "Initial carrier / feeder support not confirmed: " +
          environment.diagnostic,
      );
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
  } catch (e) {
    physics.dispose();
    throw e;
  }
}

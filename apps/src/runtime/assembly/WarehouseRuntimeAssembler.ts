/** 组装仓储场景的输送带、滑轨、升降台和货架库存，将 DSL 请求与轴运动、物料交接及格位预留关联起来。 */

import { Vector3 } from "three";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import type {
  ActionRequest,
  ActionFeedback,
  ActionBinding,
} from "@/contracts/scheduler";
import type { BodyPose } from "@/contracts/physics";
import type { ConditionContext } from "@/contracts/conditions";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import { PositionTransportAdapter } from "@/runtime/adapters/scene/PositionTransportAdapter";
import { LinearRailSceneAdapter } from "@/runtime/adapters/scene/LinearRailSceneAdapter";
import {
  LiftSceneAdapter,
  transferFields,
  type TransferRequest,
} from "@/runtime/adapters/scene/LiftSceneAdapter";
import { DeviceMountService } from "@/runtime/services/DeviceMountService";
import { StorageRackRuntime } from "@/runtime/services/StorageRackRuntime";
import { createJoltBackend } from "@/runtime/physics/jolt/JoltPhysicsBackend";
import { SceneRuntimeProgram } from "@/runtime/engine/SceneRuntimeProgram";
import { SignalRegistry } from "@/runtime/signals/SignalRegistry";
import { ObservationRegistry } from "@/runtime/signals/ObservationRegistry";
import { ConditionProviders } from "@/runtime/signals/ConditionProviders";
import { ConditionTrace } from "@/runtime/signals/ConditionTrace";
import {
  bindDeviceBehavior,
  signalLayoutFromContract,
} from "@/domain/runtime/bindDeviceBehavior";
import { bindProcess } from "@/domain/runtime/bindProcess";
import { compileConditions } from "@/domain/runtime/compileConditions";
import { resolveDock } from "@/domain/runtime/DockingTargetResolver";
import { sweptLoadBlocker } from "@/domain/runtime/warehouseClearance";
interface WorldState {
  bodies: Record<
    string,
    { active: boolean; pose?: BodyPose; supports: string[] }
  >;
  owners: Record<string, string>;
  stopped: Record<string, boolean>;
  outcomes: Record<string, ActionFeedback>;
  requests: Record<string, ActionRequest>;
  mounts: Record<
    string,
    {
      stopped: boolean;
      transferring: boolean;
      held?: string;
      rail: number;
      lift: number;
    }
  >;
  inventory: ReturnType<StorageRackRuntime["snapshot"]>;
  receipts: {
    material: string;
    target: string;
    request: string;
    tick: number;
  }[];
  transfers: Record<
    string,
    ReturnType<NonNullable<LiftSceneAdapter["transfer"]>["snapshot"]>
  >;
}
export async function assembleWarehouseRuntime(
  sceneId: string,
  runId: string,
  compiled: CompiledSceneRuntime,
) {
  const config = compiled.warehouse!;
  const physics = await createJoltBackend(compiled.physics);
  try {
    const mounts = config.assemblies.map(
      (a) => new DeviceMountService(a, physics),
    );
    const mountByDevice = new Map(
      mounts.flatMap(
        (m) =>
          [
            [m.config.rail, m],
            [m.config.lift, m],
          ] as const,
      ),
    );
    const storage = new StorageRackRuntime(
      new Set(
        [...config.locations]
          .filter(([, l]) => l.kind === "slot")
          .map(([id]) => id),
      ),
    );
    const owners = new Map(config.jobs.map((j) => [j.material, "@supply"]));
    const receipts: WorldState["receipts"] = [],
      outcomes = new Map<string, ActionFeedback>(),
      requests = new Map<string, ActionRequest>();
    const drivers: DeviceActionPort[] = [],
      belts = new Map<string, PositionTransportAdapter>();
    const signals = new SignalRegistry(
      runId,
      [...compiled.devices.values()]
        .filter((d) => !d.asset_kind?.endsWith("_prefab"))
        .flatMap((d) =>
          signalLayoutFromContract(sceneId, d.instance_id, d.contract),
        ),
    );
    const providers = new ConditionProviders(new ConditionTrace("expression"));
    const observation = new ObservationRegistry(runId, [
      {
        key: "world/state",
        provider: "physics",
        maxAgeTicks: 1,
        validate: (v) => !!v && typeof v === "object",
      },
    ]);
    let stopEnvironment = false,
      admitted = 0;
    const transferValidation = (t: TransferRequest) => {
      const mount = mountByDevice.get(t.request.device)!;
      if (owners.get(t.material) !== t.source || !mount?.stopped)
        throw new Error("Material source/axis state differs");
      if ([...owners.values()].includes(t.target))
        throw new Error("Destination occupied");
      const s = config.locations.get(t.source),
        d = config.locations.get(t.target);
      if (!s || !d) throw new Error("Unknown transfer location");
      if (s.kind === "slot" && !storage.contains(t.source, t.material))
        throw new Error("Wrong slot material");
      if (d.kind === "slot" && !storage.available(t.target))
        throw new Error("Slot unavailable");
      if (s.kind === "platform" && mount.held !== t.material)
        throw new Error("Platform load differs");
      const material = config.materials.get(t.material)!;
      if (!material) throw new Error("Unknown transfer material");
      const mass = compiled.bodyMap.get(material.body)!.mass!;
      const liftLimit = Number(
        compiled.devices.get(mount.config.lift)!.parameters.max_payload_kg,
      );
      const rackLimit =
        d.kind === "slot"
          ? Number(
              compiled.devices.get(d.owner)!.parameters.max_payload_per_cell_kg,
            )
          : Infinity;
      if (
        mass > liftLimit ||
        mass > rackLimit ||
        material.size[0] > d.size[0] ||
        material.size[2] > d.size[2]
      )
        throw new Error("Load exceeds destination capacity/envelope");
      const destination = new Vector3(
        ...(d.kind === "platform" ? mount.anchor : d.position),
      )
        .add(new Vector3(0, material.size[1] / 2, 0))
        .toArray();
      const poses = Object.fromEntries(
        compiled.physics.bodies!.map((b) => [
          b.id,
          {
            active: physics.isBodyActive!(b.id),
            pose: physics.isBodyActive!(b.id)
              ? physics.readBody!(b.id)
              : undefined,
          },
        ]),
      );
      const blocker = sweptLoadBlocker(
        physics.readBody!(material.body).position,
        destination,
        material.size,
        compiled.physics.bodies!,
        poses,
        new Set([material.body, mount.config.tool, mount.config.platform]),
      );
      if (blocker) throw new Error("TRANSFER_PATH_BLOCKED: " + blocker);
    };
    for (const m of mounts) {
      drivers.push(
        new LinearRailSceneAdapter(sceneId, runId, m, config.locations),
      );
      drivers.push(
        new LiftSceneAdapter(sceneId, runId, m, config, physics, {
          validate: transferValidation,
          begin: (t) => {
            transferValidation(t);
            for (const key of [t.source, t.target])
              if (config.locations.get(key)?.kind === "slot")
                storage.reserve(
                  key,
                  runId + "/" + t.request.requestId,
                  key === t.source ? t.material : undefined,
                );
            owners.set(t.material, "@transfer");
          },
          commit: (t, tick) => {
            for (const key of [t.source, t.target])
              if (config.locations.get(key)?.kind === "slot")
                storage.commit(
                  key === t.source ? "retrieved" : "stored",
                  key,
                  t.material,
                  runId + "/" + t.request.requestId,
                  tick,
                );
            owners.set(t.material, t.target);
          },
        }),
      );
    }
    for (const [id, c] of config.conveyors) {
      const belt = new PositionTransportAdapter(
        {
          sceneId,
          runId,
          leader: id,
          drives: [{ device: id, surfaceId: id + "/surface", flow: c.flow }],
          subjects: new Map(
            [...config.materials].map(([material, m]) => [
              compiled.subjectIds.get(material)!,
              { id: material, bodyId: m.body, referenceOffset: [0, 0, 0] },
            ]),
          ),
          targets: [
            {
              id: c.exit,
              index: 1,
              position: config.locations.get(c.exit)!.position,
              supportIds: [id + "/surface"],
              heightMode: "preserve_supported",
            },
          ],
          maxSpeed: c.speed,
          acceleration: 0.4,
          deceleration: 0.4,
          positionTolerance: 0.008,
          speedTolerance: 0.025,
          verticalTolerance: 0.03,
          settleTicks: 4,
        },
        physics,
        (subject, target, tick) => {
          if (
            owners.get(subject.id) !== target.id ||
            !config.jobs.some(
              (j) => j.material === subject.id && j.target === target.id,
            )
          )
            return false;
          if (receipts.some((r) => r.material === subject.id))
            throw new Error("Duplicate warehouse delivery");
          physics.deactivateBodies!([subject.bodyId]);
          owners.set(subject.id, "@delivered");
          receipts.push({
            material: subject.id,
            target: target.id,
            request: requests.get(id)!.requestId,
            tick,
          });
          return true;
        },
      );
      belts.set(id, belt);
      drivers.push(belt);
    }
    // Tracking decorates the established protocol; it never drives an independent process loop.
    for (const d of drivers) {
      const submit = d.submit.bind(d),
        drain = d.drainFeedback.bind(d);
      d.submit = (r) => {
        submit(r);
        requests.set(d.id, r);
      };
      d.drainFeedback = () => {
        const f = drain();
        for (const row of f)
          outcomes.set(row.device + "/" + row.requestId, row);
        return f;
      };
    }
    const publishWorld = () => {
      const bodies: WorldState["bodies"] = {};
      for (const b of compiled.physics.bodies!) {
        const active = physics.isBodyActive!(b.id);
        bodies[b.id] = {
          active,
          pose: active ? physics.readBody!(b.id) : undefined,
          supports:
            active && b.role === "material"
              ? [...config.locations.values()]
                  .filter((l) => physics.hasSupport(b.id, l.support))
                  .map((l) => l.support)
              : [],
        };
      }
      const transfers = Object.fromEntries(
        drivers.flatMap((d) =>
          d instanceof LiftSceneAdapter && d.transfer
            ? [[d.id, d.transfer.snapshot()]]
            : [],
        ),
      );
      const state: WorldState = {
        bodies,
        owners: Object.fromEntries(owners),
        stopped: Object.fromEntries(drivers.map((d) => [d.id, d.isStopped()])),
        outcomes: Object.fromEntries(outcomes),
        requests: Object.fromEntries(requests),
        mounts: Object.fromEntries(
          mounts.map((m) => [
            m.config.lift,
            {
              stopped: m.stopped,
              transferring: m.transferring,
              held: m.held,
              rail: m.actual("rail"),
              lift: m.actual("lift"),
            },
          ]),
        ),
        inventory: storage.snapshot(),
        receipts: [...receipts],
        transfers,
      };
      return state;
    };
    // Use one full observation frame for conditions, rendering, and independent goals.
    let pendingWorld: WorldState | undefined;
    const environment: DeviceActionPort = {
      id: "@warehouse",
      supports: () => false,
      prepare: () => {
        throw new Error("Environment cannot be invoked");
      },
      prepareCancel: () => [],
      prepareStop: () => [],
      submit: () => {},
      cancel: () => {},
      beforePhysics: (dt) => {
        if (!stopEnvironment && admitted < config.jobs.length) {
          const job = config.jobs[admitted],
            entry = config.locations.get(job.input)!;
          const blocked = [...owners].some(
            ([id, owner]) =>
              owner !== "@delivered" &&
              (owner === job.input ||
                owner === config.conveyors.get(entry.owner)!.exit ||
                (physics.isBodyActive!(config.materials.get(id)!.body) &&
                  physics.hasSupport(
                    config.materials.get(id)!.body,
                    entry.support,
                  ))),
          );
          if (!blocked && belts.get(entry.owner)!.isStopped()) {
            const m = config.materials.get(job.material)!;
            physics.activateBodies!([
              {
                id: m.body,
                pose: {
                  position: [
                    entry.position[0],
                    entry.position[1] + m.size[1] / 2 + 0.002,
                    entry.position[2],
                  ],
                  rotation: [0, 0, 0, 1],
                  velocity: [0, 0, 0],
                },
              },
            ]);
            owners.set(job.material, job.input);
            admitted++;
          }
        }
        mounts.forEach((m) => m.beforePhysics(dt));
      },
      afterPhysics: () => {
        for (const [id, belt] of belts) {
          const c = config.conveyors.get(id)!;
          for (const [material, owner] of owners)
            if (owner === c.entry && belt.completedAt(material, c.exit))
              owners.set(material, c.exit);
        }
        pendingWorld = publishWorld();
      },
      requestStop: () => {
        stopEnvironment = true;
        mounts.forEach((m) => m.stop());
      },
      isStopped: () => mounts.every((m) => m.stopped),
      dispose: () => {},
      drainSignals: () => [],
      drainFeedback: () => [],
      drainObservations: () => {
        const state = pendingWorld;
        pendingWorld = undefined;
        return state
          ? [{ key: "world/state", provider: "physics", runId, value: state }]
          : [];
      },
    };
    const world = (c: ConditionContext) => {
      const s = c.observations?.samples["world/state"];
      return s?.quality === "good" && s.runId === runId
        ? (s.value as WorldState)
        : undefined;
    };
    const footprint = (r: ActionRequest) => {
      const m = mountByDevice.get(r.device),
        base = ["device/" + r.device];
      if (m) base.push("device/" + m.config.rail, "device/" + m.config.lift);
      if (r.payload) {
        const t = transferFields(r.device, r);
        base.push(
          "material/" + t.material,
          "location/" + t.source,
          "location/" + t.target,
        );
        for (const key of [t.source, t.target]) {
          const l = config.locations.get(key);
          if (l && l.kind === "conveyor") base.push("device/" + l.owner);
        }
      } else if (r.arguments.subject_id !== undefined) {
        const id = [...compiled.subjectIds].find(
          ([, n]) => n === r.arguments.subject_id,
        )?.[0];
        if (!id) throw new Error("Unknown material identity");
        base.push("material/" + id);
      }
      return base;
    };
    const ready = (r: ActionRequest, w: WorldState) => {
      if (!w.stopped[r.device]) return false;
      const m = mountByDevice.get(r.device);
      if (m) {
        if (!w.mounts[m.config.lift]?.stopped) return false;
        if (r.payload) {
          const t = transferFields(r.device, r),
            source = config.locations.get(t.source),
            target = config.locations.get(t.target);
          if (
            !source ||
            !target ||
            !m.config.routes.some(
              (route) =>
                route.sources.includes(t.source) &&
                route.targets.includes(t.target),
            )
          )
            throw new Error("Invalid named route");
          return (
            w.owners[t.material] === t.source &&
            !Object.values(w.owners).includes(t.target) &&
            !w.inventory.reservations[t.source] &&
            !w.inventory.reservations[t.target]
          );
        }
        if (r.arguments.target !== undefined) {
          const l = config.locations.get(String(r.arguments.target));
          if (!l) throw new Error("Unknown named target");
          const dock = resolveDock(m.config, l);
          const axis = r.device === m.config.rail ? "rail" : "lift";
          m.checkLoadedPath(
            axis,
            dock[axis],
            w.mounts[m.config.lift].held
              ? config.materials.get(w.mounts[m.config.lift].held!)
              : undefined,
            compiled.physics.bodies!,
            w.bodies,
          );
        } else if (
          r.arguments.position_m !== undefined ||
          r.arguments.move_to_level !== undefined
        ) {
          const axis = r.device === m.config.rail ? "rail" : "lift";
          const quantity = (
            axis === "rail" ? r.arguments.position_m : r.arguments.move_to_level
          ) as { value: number; unit: string };
          const target =
            quantity.value - (axis === "lift" ? m.config.restHeight : 0);
          if (
            quantity.unit !== "m" ||
            !Number.isFinite(target) ||
            target < m[axis].limits[0] ||
            target > m[axis].limits[1]
          )
            throw new Error("Axis target outside limits");
          m.checkLoadedPath(
            axis,
            target,
            w.mounts[m.config.lift].held
              ? config.materials.get(w.mounts[m.config.lift].held!)
              : undefined,
            compiled.physics.bodies!,
            w.bodies,
          );
        }
        return true;
      }
      if (r.behavior === "stop_conveying") return true;
      const material = [...compiled.subjectIds].find(
        ([, n]) => n === r.arguments.subject_id,
      )?.[0];
      if (!material) return false;
      const b = w.bodies[config.materials.get(material)!.body],
        c = config.conveyors.get(r.device)!;
      return (
        b.active &&
        b.supports.includes(r.device + "/surface") &&
        Math.hypot(...b.pose!.velocity) < 0.03 &&
        [c.entry, c.exit].includes(w.owners[material])
      );
    };
    const bindings: ActionBinding[] = [];
    const unique = new Map(
      compiled.bundle.calls.map((c) => [c.device + "." + c.behavior, c]),
    );
    for (const call of unique.values()) {
      const d = compiled.devices.get(call.device)!;
      const rules = compileConditions(call.device, d.contract, call.behavior);
      for (const rule of rules) {
        const evaluator = (c: ConditionContext) => {
          const w = world(c),
            r = c.request as ActionRequest | undefined;
          if (!w || !r) return undefined;
          if (rule.phase === "precondition") return ready(r, w);
          if (rule.phase === "authorization")
            return ready(r, w) && footprint(r).every((k) => c.owns(k));
          const record = w.requests[r.device],
            match =
              record?.runId === r.runId &&
              record?.requestId === r.requestId &&
              record?.activationId === r.activationId;
          if (!match) return false;
          const result = w.outcomes[r.device + "/" + r.requestId];
          if (rule.phase === "sustaining") return result?.status !== "failed";
          if (rule.phase === "completion")
            return (
              result?.status === "succeeded" &&
              result.activationId === r.activationId
            );
          throw new Error("Unregistered warehouse condition phase");
        };
        // Warehouse predicates are explicit opaque native blocks, recorded by ConditionTrace.
        if (rule.expr.op !== "opaque")
          throw new Error("Unsupported warehouse condition expression");
        providers.registerExpression(
          rule,
          () => {
            throw new Error("Unexpected warehouse binding");
          },
          evaluator,
        );
      }
      const stopped = call.device + "/" + call.behavior + ".stopped";
      providers.register(stopped, {
        evaluate: (c) => {
          const w = world(c),
            r = c.request as ActionRequest | undefined;
          return w && r
            ? w.stopped[r.device] &&
                w.requests[r.device]?.requestId === r.requestId
            : undefined;
        },
      });
      bindings.push(
        bindDeviceBehavior(call.device, d.contract, call.behavior, {
          contractVersion: String(d.contract.version),
          parameters: d.parameters,
          stopped: [stopped],
          resources: (c) => footprint(c.request! as ActionRequest),
          validatePayload: (p) => {
            if (
              d.contract.device_type === "lift_table" &&
              [
                "accept_material",
                "release_material",
                "transfer_material",
              ].includes(call.behavior)
            ) {
              const r = {
                device: call.device,
                behavior: call.behavior,
                payload: p,
              } as ActionRequest;
              transferFields(call.device, r);
            } else if (p !== undefined)
              throw new Error("Unexpected action payload");
          },
        }),
      );
    }
    providers.register("warehouse/complete", {
      evaluate: (c) => {
        const w = world(c);
        if (!w) return undefined;
        return (
          config.jobs.every((j) => {
            const stored = w.inventory.events.find(
                (e) =>
                  e.kind === "stored" &&
                  e.material === j.material &&
                  e.slot === j.slot,
              ),
              retrieved = w.inventory.events.find(
                (e) =>
                  e.kind === "retrieved" &&
                  e.material === j.material &&
                  e.slot === j.slot,
              );
            return (
              !!stored &&
              !!retrieved &&
              stored.tick < retrieved.tick &&
              w.receipts.filter(
                (r) => r.material === j.material && r.target === j.target,
              ).length === 1
            );
          }) &&
          w.receipts.length === config.jobs.length &&
          Object.values(w.stopped).every(Boolean) &&
          Object.values(w.mounts).every((m) => !m.held && !m.transferring) &&
          Object.keys(w.inventory.reservations).length === 0 &&
          Object.keys(w.inventory.occupancy).length === 0
        );
      },
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
      finalization: ["warehouse/complete"],
      readers: {
        subject_id: (args) => {
          const n = compiled.subjectIds.get(String(args[0]));
          if (!n) throw new Error("Unknown material identity");
          return n;
        },
      },
    });
    const all = [...drivers, environment];
    // Physically settle the first admitted material before presenting ready.
    for (let i = 0; i < 120; i++) {
      all.forEach((d) => d.beforePhysics(1 / 60, 0));
      physics.step(1 / 60);
      all.forEach((d) => d.afterPhysics(1 / 60, 0));
      signals.publishFeedback(
        drivers.flatMap((d) => [...d.drainSignals()]),
        0,
      );
      observation.publish(environment.drainObservations!(), 0);
    }
    const first = config.materials.get(config.jobs[0].material)!;
    if (
      !physics.hasContactSupport!(
        first.body,
        config.locations.get(config.jobs[0].input)!.support,
      ) ||
      Math.hypot(...physics.readBody!(first.body).velocity) > 0.03
    )
      throw new Error("Initial material support not confirmed");
    // Conveyor-specific observations are not consumed by this profile; discard them each tick.
    for (const d of drivers)
      if (d instanceof PositionTransportAdapter) {
        const after = d.afterPhysics.bind(d),
          drain = d.drainObservations.bind(d);
        d.afterPhysics = (dt, tick) => {
          after(dt, tick);
          drain();
        };
        drain();
        d.drainObservations = () => [];
      }
    return {
      compiled,
      program: new SceneRuntimeProgram(
        sceneId,
        runId,
        process,
        signals,
        physics,
        all,
        observation,
      ),
    };
  } catch (e) {
    physics.dispose();
    throw e;
  }
}

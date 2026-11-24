/** 独立设备在同一 Jolt 世界中按两步 DSL 运行，工步间同时核对因果回执和当前物理支承。 */
import { Vector3 } from "three";
import type { TransferWorkcell } from "@/domain/runtime/compileTransferWorkcell";
import {
  connectedFactsHold,
  type FactReceipt,
  type SemanticFact,
} from "@/domain/runtime/compileSignalConnections";
import {
  bindDeviceBehavior,
  signalLayoutFromContract,
} from "@/domain/runtime/bindDeviceBehavior";
import { bindProcess } from "@/domain/runtime/bindProcess";
import type {
  ConditionContext,
  ObservationWrite,
  DeviceConditionBindings,
} from "@/contracts/conditions";
import type { ActionBinding, ActionRequest } from "@/contracts/scheduler";
import type { BodyPose } from "@/contracts/physics";
import { getDeviceModule } from "@/devices/registry";
import type { DeviceActionPort } from "../adapters/scene/DeviceActionPort";
import { createJoltBackend } from "../physics/jolt/JoltPhysicsBackend";
import {
  ConditionProviders,
  ObservationRegistry,
  SignalRegistry,
} from "../signals";
import { SceneRuntimeProgram } from "../engine/SceneRuntimeProgram";
import { observeRegions } from "../engine/RegionObserver";

interface CellReading {
  pose: BodyPose;
  supported: boolean;
  atExit: boolean;
  stationary: boolean;
  held: boolean;
  targetSupported: boolean;
  receipts: FactReceipt[];
}
interface ArmReading {
  q: number[];
  qdot: number[];
  tcp: BodyPose;
  phase: string;
  holding: boolean;
  placementConfirmed: boolean;
  motionIntegrity: boolean;
}

export async function assembleTransferWorkcell(
  c: TransferWorkcell,
  sceneId: string,
  runId: string,
) {
  const physics = await createJoltBackend(c.physics);
  try {
    const { conveyor, material, robot, support } = c.selection;
    const robotModule = getDeviceModule("robot_arm");
    const speed = c.belt.speed;
    const positionTolerance = 0.015,
      speedTolerance = 0.02;
    const drive = getDeviceModule("conveyor").createSceneDriver(
      {
        sceneId,
        runId,
        leader: conveyor,
        drives: [
          {
            device: conveyor,
            surfaceId: c.sourceSurface,
            flow: c.physics.surfaces[0].direction,
          },
        ],
        subjects: new Map([
          [
            1,
            {
              id: material,
              bodyId: c.materialBody,
              referenceOffset: [0, 0, 0],
            },
          ],
        ]),
        targets: [
          {
            id: c.location,
            index: 1,
            position: c.exitPoint,
            supportIds: [c.sourceSurface],
            heightMode: "preserve_supported",
          },
        ],
        maxSpeed: speed,
        acceleration:
          c.belt.referenceSpeed / Math.max(1 / 60, c.belt.accelTime),
        deceleration:
          c.belt.referenceSpeed / Math.max(1 / 60, c.belt.decelTime),
        positionTolerance,
        verticalTolerance: 0.03,
        speedTolerance,
        settleTicks: 3,
        publishDriveState: true,
        onSucceeded: recordArrival,
        subjectIdPort: "subject_id",
        inventoryFeedback: {
          partReadyPort: "part_ready",
          capacityPort: "capacity_available",
          capacity: 1,
        },
      },
      physics,
    );
    const atDestination = (pose: BodyPose) =>
      physics.hasContactSupport!(c.materialBody, c.targetSurface) &&
      !physics.hasGraspForBody!(c.materialBody) &&
      Math.hypot(...pose.velocity) <= speedTolerance &&
      new Vector3(...pose.position).distanceTo(
        new Vector3(...c.robot.placementCenter!),
      ) <=
        2 * positionTolerance;
    const arm = robotModule.createSceneDriver(
      sceneId,
      runId,
      c.robot,
      physics,
      (request) => ({
        scene: c.robot,
        steps: robotModule.pickPlaceSteps(
          c.robot,
          physics.readBody!(c.materialBody),
          "preserve_orientation",
          (request.payload as { fields: { grasp?: string } }).fields.grasp,
        ),
      }),
      () => atDestination(physics.readBody!(c.materialBody)),
    );

    const trace: FactReceipt[] = [];
    const signal = new SignalRegistry(runId, [
      ...signalLayoutFromContract(sceneId, conveyor, c.beltDefinition.source!),
      ...signalLayoutFromContract(sceneId, robot, c.robotDefinition.source!),
    ]);
    const obs = new ObservationRegistry(
      runId,
      [
        ...["loads", "transport", "drive_state"].map((s) => ({
          key: conveyor + "/" + s,
          provider: "adapter:" + conveyor,
        })),
        { key: robot + "/robot_state", provider: "adapter:" + robot },
        { key: "cell/state", provider: "physics" },
      ].map((d) => ({
        ...d,
        maxAgeTicks: 1,
        validate: (v: unknown) => !!v && typeof v === "object",
      })),
    );
    const reading = (): CellReading => {
      const pose = physics.readBody!(c.materialBody),
        supported = physics.hasContactSupport!(c.materialBody, c.sourceSurface);
      return {
        pose,
        supported,
        atExit: observeRegions(c.belt, pose, supported).atExit,
        stationary: Math.hypot(...pose.velocity) <= speedTolerance,
        held: physics.hasGraspForBody!(c.materialBody),
        targetSupported: atDestination(pose),
        receipts: trace,
      };
    };
    let published: ObservationWrite[] = [];
    const world: DeviceActionPort = {
      id: "@workcell",
      supports: () => false,
      prepare() {
        throw new Error("观测服务无执行入口");
      },
      submit() {
        throw new Error("观测服务无执行入口");
      },
      prepareStop: () => [],
      prepareCancel: () => [],
      cancel() {},
      requestStop() {},
      isStopped: () =>
        physics.isMotionStopped!() && !physics.hasGraspForBody!(c.materialBody),
      dispose() {},
      beforePhysics() {},
      afterPhysics() {
        published = [
          { key: "cell/state", runId, provider: "physics", value: reading() },
        ];
      },
      drainFeedback: () => [],
      drainSignals: () => [],
      drainObservations() {
        const out = published;
        published = [];
        return out;
      },
    };
    const drivers: DeviceActionPort[] = [drive, arm, world];
    const providers = new ConditionProviders();
    const sample = (ctx: ConditionContext) => {
      const v = ctx.observations?.samples["cell/state"];
      return v?.runId === runId && v.quality === "good"
        ? (v.value as CellReading)
        : undefined;
    };
    function measured(w: CellReading, f: SemanticFact): boolean | undefined {
      if (f.subject === material && f.endpoint === c.location) {
        if (f.semantic === "at") return w.atExit;
        if (f.semantic === "supported_at") return w.supported;
      }
      if (
        f.semantic === "supported_at" &&
        f.subject === material &&
        f.endpoint === c.destination
      )
        return w.targetSupported;
      if (
        f.semantic === "stopped" &&
        f.subject === conveyor &&
        f.endpoint === conveyor
      )
        return drive.isStopped();
      return undefined;
    }
    const register = (
      id: string,
      key: string,
      fn: (w: CellReading, ctx: ConditionContext) => boolean | undefined,
    ) => {
      providers.register(id + "/" + key, {
        evaluate: (ctx) => {
          const w = sample(ctx);
          return w && fn(w, ctx);
        },
      });
    };
    const deviceOutput = (id: string, name: string, ctx: ConditionContext) => {
      const s = ctx.frame.samples[sceneId + "/" + id + "/" + name];
      return s?.quality === "good" && s.runId === runId ? s.value : undefined;
    };
    const wired = (w: CellReading, ctx: ConditionContext) => {
      if (
        !ctx.nodeId ||
        !ctx.successfulPredecessor ||
        !c.placements.has(ctx.nodeId)
      )
        return false;
      return connectedFactsHold(
        c.connections,
        ctx.nodeId,
        ctx,
        w.receipts,
        (f) => measured(w, f),
        ctx.successfulPredecessor,
      );
    };
    const bindings = (id: string): DeviceConditionBindings<CellReading> => ({
      register: (key, check) => register(id, key, check),
      signal: (key, ctx) => deviceOutput(id, key, ctx),
    });
    getDeviceModule("conveyor").bindExitConditions(bindings(conveyor), drive, {
      material,
      location: c.location,
      target: c.exitPoint,
      flow: c.physics.surfaces[0].direction,
      positionTolerance,
      speed,
    });
    robotModule.bindPickPlaceConditions(bindings(robot), arm, {
      robot,
      material,
      source: c.location,
      destination: c.destination,
      sourceEvidence: wired,
    });
    const actions: ActionBinding[] = [
      bindDeviceBehavior(
        conveyor,
        c.beltDefinition.source!,
        "transport_to_exit",
        {
          contractVersion: c.beltDefinition.revision,
          resources: () => ["material/" + material, "location/" + c.location],
          stopped: [conveyor + "/stopped"],
          validatePayload: (p) => {
            if (p !== undefined) throw new Error("输送工步只接受登记号");
          },
        },
      ),
      bindDeviceBehavior(robot, c.robotDefinition.source!, "pick_and_place", {
        contractVersion: c.robotDefinition.revision,
        resources: () => [
          "material/" + material,
          "location/" + c.location,
          "location/" + c.destination,
          "device/" + support,
        ],
        stopped: [robot + "/stopped"],
        validatePayload: (p) => {
          const v = p as
            { binding?: string; fields?: Record<string, string> } | undefined;
          if (
            !v ||
            !["arm.pick_and_place", robot + ".pick_and_place"].includes(
              v.binding ?? "",
            ) ||
            v.fields?.material !== material ||
            v.fields.source !== c.location ||
            v.fields.target !== c.destination
          )
            throw new Error("抓放请求与已绑定端点不一致");
        },
      }),
    ];
    register(
      robot,
      "goal",
      (w) =>
        w.targetSupported &&
        !w.held &&
        arm.isStopped() &&
        drive.isStopped() &&
        program.scheduler
          .snapshot()
          .activations.some(
            (a) =>
              c.placements.has(a.node) &&
              a.state === "succeeded" &&
              a.subjectId === material,
          ),
    );
    const process = bindProcess(c.root, {
      deviceInstances: { belt: conveyor, arm: robot },
      scope: c.scope,
      readers: c.readers,
      actions,
      providers,
      finalization: [robot + "/goal"],
    });
    // Publish actual effects under the producer's identity before the next tick.
    function recordArrival(request: ActionRequest) {
      if (request.behavior !== "transport_to_exit") return;
      const producer = program.scheduler.nodeForActivation(
        request.activationId,
      );
      if (!producer || !c.arrivals.has(producer))
        throw new Error("输送回执无法匹配工步");
      const w = reading(),
        facts = c.steps.get(producer)!.provides;
      for (const fact of facts)
        if (measured(w, fact) !== true)
          throw new Error("输送结束时缺少实际证据 " + fact.semantic);
      trace.push(
        ...facts.map((fact) => ({
          producer,
          fact,
          runId: request.runId,
          activationId: request.activationId,
          requestId: request.requestId,
        })),
      );
    }
    let stable = false;
    for (let i = 0; i < 120 && !stable; i++) {
      drivers.forEach((d) => d.beforePhysics(1 / 60, 0));
      physics.step(1 / 60);
      drivers.forEach((d) => d.afterPhysics(1 / 60, 0));
      signal.publishFeedback(
        drivers.flatMap((d) => [...d.drainSignals()]),
        0,
      );
      obs.publish(
        drivers.flatMap((d) => [...(d.drainObservations?.() ?? [])]),
        0,
      );
      const w = reading();
      stable = w.supported && w.stationary;
    }
    if (!stable) throw new Error("工件未在所选输送带稳定支承");
    const program = new SceneRuntimeProgram(
      sceneId,
      runId,
      process,
      signal,
      physics,
      drivers,
      obs,
    );
    return program;
  } catch (e) {
    physics.dispose();
    throw e;
  }
}
export type { ArmReading, CellReading };

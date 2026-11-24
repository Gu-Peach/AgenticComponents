/** 输送设备的单机驱动、位置输送、联动控制与出口交付。 */
import { Quaternion, Vector3 } from "three";
import type { DeviceTemplate } from "@/contracts/device-template";
import type {
  CompiledRuntimeScene,
  RuntimeSnapshot,
} from "@/contracts/runtime";
import type { CompiledSceneRuntime, Vec3 } from "@/contracts/scene-execution";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import type { ActionRequest, ActionFeedback } from "@/contracts/scheduler";
import type { SceneSignalFrame, SignalWrite } from "@/contracts/scene-signals";
import type {
  ObservationWrite,
  DeviceConditionBindings,
} from "@/contracts/conditions";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import { DeviceRequestLatch } from "@/runtime/engine/DeviceRequestLatch";
import { immutable } from "@/runtime/scheduler/expressions";
import { Encoder } from "@/runtime/mechanisms/Encoder";
import { ramp } from "@/runtime/mechanisms/SpeedRamp";
import { SignalRegistry } from "@/runtime/engine/SignalRegistry";
import { ActionGateway } from "@/runtime/engine/ActionGateway";
import { RunOwnership } from "@/runtime/engine/RunOwnership";
import { observeRegions } from "@/runtime/engine/RegionObserver";
import { bodyOf, originOffset } from "../workpiece/behavior";

/** 保存单台输送带的当前带速和累计行程编码器，供模板在连续的物理步之间复用。 */
export class ConveyorState {
  speed = 0;
  encoder = new Encoder();
}

/** 在物理步开始前根据启停和速度信号调整带速，步进后发布实际速度、编码器行程、物料到位和请求状态。 */
export const ConveyorTemplate: DeviceTemplate = {
  id: "conveyor.continuous-contact",
  version: "1",
  create(config) {
    const state = new ConveyorState();
    return {
      beforePhysics(dt, signals, physics) {
        const target = signals.read("runTag")
          ? Number(signals.read("speedTag"))
          : 0;
        state.speed = ramp(
          state.speed,
          target,
          dt,
          config.referenceSpeed,
          config.accelTime,
          config.decelTime,
        );
        physics.setSurfaceSpeed(state.speed);
      },
      afterPhysics(ctx) {
        const distance = state.encoder.step(ctx.appliedSpeed, ctx.dt);
        for (const [id, value] of Object.entries({
          actual_speed: ctx.appliedSpeed,
          runningTag: Math.abs(ctx.appliedSpeed) > config.speedTolerance,
          encoderTag: distance,
          device_ready: true,
          subject_on_conveyor: ctx.support,
          part_ready: ctx.atExit,
          entry_region_clear: ctx.entryClear,
          capacity_available: ctx.entryClear,
          accepted:
            ctx.request?.status === "busy" ||
            ctx.request?.status === "succeeded",
          done: ctx.request?.status === "succeeded",
          busy: ctx.request?.status === "busy",
          error: ctx.request?.status === "failed",
        }))
          ctx.publish(id, value);
      },
      dispose() {},
    };
  },
};

/** 运行单输送带仿真，每步驱动输送带模板和物理世界，并根据支承、入口和出口状态更新请求结果及设备快照。 */
export class ConveyorProgram {
  readonly signals = new SignalRegistry();
  readonly tasks: ActionGateway;
  private owners = new RunOwnership();
  private script;
  private tick = 0;
  private disposed = false;
  private speed = 0;
  private arrivalStopped = false;
  private current: RuntimeSnapshot;
  constructor(
    readonly scene: CompiledRuntimeScene,
    private physics: PhysicsPort,
  ) {
    this.tasks = new ActionGateway(scene.subjectId);
    this.owners.claim(scene.instanceId);
    this.owners.claim(scene.subjectId);
    if (scene.templateId !== ConveyorTemplate.id)
      throw new Error("模板未支持: " + scene.templateId);
    this.script = ConveyorTemplate.create(scene);
    this.signals.command("runTag", false);
    this.signals.command("speedTag", scene.speed);
    this.signals.begin(0);
    this.current = {
      status: "ready",
      tick: 0,
      time: 0,
      instanceId: scene.instanceId,
      subjectId: scene.subjectId,
      pose: physics.readMaterial(),
      size: scene.physics.materialSize,
      materialInstanceId: scene.materialInstanceId,
      bodyLocalMatrix: scene.bodyLocalMatrix,
      signals: this.signals.snapshot(),
      supported: false,
      atExit: false,
      request: null,
    };
  }
  step(dt: number) {
    if (this.disposed) throw new Error("会话已结束");
    if (!Number.isFinite(dt) || Math.abs(dt - 1 / 60) > 1e-8)
      throw new Error("只接受固定 1/60 秒逻辑步");
    this.tick++;
    this.signals.begin(this.tick);
    const observedPhysics = {
      setSurfaceSpeed: (s: number) => {
        this.speed = s;
        this.physics.setSurfaceSpeed(s);
      },
    };
    this.script.beforePhysics(dt, this.signals, observedPhysics);
    this.physics.step(dt);
    const pose = this.physics.readMaterial(),
      supported = this.physics.hasSupport(),
      region = observeRegions(this.scene, pose, supported);
    this.tasks.observe(
      this.tick,
      supported,
      region.atExit,
      region.fallen,
      this.scene.timeout,
    );
    if (this.tasks.request?.status === "succeeded" && !this.arrivalStopped) {
      this.signals.command("runTag", false);
      this.arrivalStopped = true;
    }
    this.script.afterPhysics({
      dt,
      tick: this.tick,
      appliedSpeed: this.speed,
      support: supported,
      atExit: region.atExit,
      entryClear: region.entryClear,
      request: this.tasks.request,
      publish: (id, value) => this.signals.publish(id, value, this.tick),
    });
    this.current = {
      ...this.current,
      status: "running",
      tick: this.tick,
      time: this.tick * dt,
      pose,
      supported,
      atExit: region.atExit,
      signals: this.signals.snapshot(),
      request: this.tasks.request ? { ...this.tasks.request } : null,
    };
    return this.snapshot();
  }
  snapshot() {
    return structuredClone(this.current);
  }
  stop() {
    if (this.disposed) return this.snapshot();
    this.disposed = true;
    this.tasks.cancel();
    this.current = {
      ...this.current,
      status: "stopped",
      request: this.tasks.request ? { ...this.tasks.request } : null,
    };
    this.signals.publish("busy", false, this.tick);
    this.current.signals = this.signals.snapshot();
    this.physics.setSurfaceSpeed(0);
    this.script.dispose();
    this.physics.dispose();
    this.owners.clear();
    return this.snapshot();
  }
}

/** 控制单段或联动输送带的速度，根据指定物料与目标点的距离、支承和停稳状态确认到位，并处理配置好的出口交付。 */
export interface TransportSubject {
  id: string;
  bodyId: string;
  referenceOffset: [number, number, number];
}
export interface TransportTarget {
  heightMode?: "preserve_supported";
  id: string;
  index: number;
  position: [number, number, number];
  supportIds: string[];
}
export interface TransportDrive {
  device: string;
  surfaceId: string;
  flow: [number, number, number];
}
export interface PositionTransportConfig {
  /** Optional PLC projections. API-only devices can leave the opcode unbound. */
  subjectIdPort?: string;
  onSucceeded?: (request: ActionRequest) => void;
  behaviorCodes?: Readonly<Record<string, number>>;
  publishDriveState?: boolean;
  sceneId: string;
  runId: string;
  leader: string;
  drives: TransportDrive[];
  subjects: ReadonlyMap<number, TransportSubject>;
  targets: readonly TransportTarget[];
  admissionSupportIds?: readonly string[];
  maxSpeed: number;
  acceleration: number;
  deceleration: number;
  positionTolerance: number;
  speedTolerance: number;
  verticalTolerance: number;
  settleTicks: number;
  releasePermissionPort?: string;
  inventoryFeedback?: {
    partReadyPort: string;
    capacityPort: string;
    capacity: number;
  };
}
/** A single finite request controls every member of a coupled conveyor group. */
export class PositionTransportAdapter implements DeviceActionPort {
  readonly id: string;
  private request?: ActionRequest;
  private subject?: TransportSubject;
  private target?: TransportTarget;
  private speed = 0;
  private encoder = 0;
  private stopping = false;
  private terminal = false;
  private succeeded = false;
  private settled = 0;
  private error = "";
  private readonly handshake: DeviceRequestLatch;
  private prepared?: {
    source: ActionRequest;
    frozen: ActionRequest;
    resolved?: { subject: TransportSubject; target: TransportTarget };
  };
  private feedback: ActionFeedback[] = [];
  private signals: SignalWrite[] = [];
  private observations: ObservationWrite[] = [];
  private direction: Vector3;
  constructor(
    private config: PositionTransportConfig,
    private physics: PhysicsPort,
    private release?: (
      subject: TransportSubject,
      target: TransportTarget,
      tick: number,
    ) => boolean,
  ) {
    this.config = {
      ...config,
      drives: structuredClone(config.drives),
      targets: structuredClone(config.targets),
      subjects: new Map(
        [...config.subjects].map(([id, value]) => [id, structuredClone(value)]),
      ),
      admissionSupportIds: config.admissionSupportIds
        ? [...config.admissionSupportIds]
        : undefined,
    };
    this.id = config.leader;
    this.handshake = new DeviceRequestLatch(
      config.sceneId,
      config.runId,
      this.id,
      "execute",
    );
    const codes = Object.values(config.behaviorCodes ?? {});
    if (
      codes.some(
        (code) => !Number.isInteger(code) || code < -32768 || code > 32767,
      ) ||
      new Set(codes).size !== codes.length
    )
      throw new Error("Invalid conveyor behavior-code mapping");
    this.config.behaviorCodes =
      config.behaviorCodes && Object.freeze({ ...config.behaviorCodes });
    if (
      !physics.setSurfaceSpeeds ||
      !physics.getSurfaceSpeed ||
      !physics.readBody
    )
      throw new Error("Multi-surface physics port required");
    if (
      !config.drives.length ||
      new Set(config.drives.map((d) => d.surfaceId)).size !==
        config.drives.length ||
      new Set(config.drives.map((d) => d.device)).size !==
        config.drives.length ||
      !config.drives.some((d) => d.device === config.leader)
    )
      throw new Error("Invalid drive group");
    this.direction = new Vector3(...config.drives[0].flow);
    if (
      Math.abs(this.direction.length() - 1) > 1e-6 ||
      Math.abs(this.direction.y) > 1e-6 ||
      config.drives.some(
        (d) => new Vector3(...d.flow).distanceTo(this.direction) > 1e-6,
      )
    )
      throw new Error("Coupled drives require the same horizontal unit flow");
    if (
      [
        config.maxSpeed,
        config.acceleration,
        config.deceleration,
        config.positionTolerance,
        config.speedTolerance,
        config.verticalTolerance,
      ].some((v) => !Number.isFinite(v) || v <= 0) ||
      !Number.isInteger(config.settleTicks) ||
      config.settleTicks < 1
    )
      throw new Error("Invalid motion profile");
    if (
      new Set(config.targets.map((t) => t.id)).size !== config.targets.length ||
      new Set(config.targets.map((t) => t.index)).size !==
        config.targets.length ||
      config.targets.some(
        (t) =>
          !Number.isInteger(t.index) ||
          t.index < 1 ||
          t.index > 32767 ||
          !t.position.every(Number.isFinite) ||
          !t.supportIds.length,
      )
    )
      throw new Error("Invalid target registry");
  }
  supports(behavior: string) {
    return (
      behavior === "transport_to_position" ||
      behavior === "stop_conveying" ||
      (behavior === "transport_to_exit" &&
        this.config.targets.some((t) => t.id === this.id + ".exit")) ||
      (behavior === "release_material" &&
        !!this.release &&
        this.config.targets.some((t) => t.id === this.id + ".exit"))
    );
  }
  private point(pose: BodyPose, subject: TransportSubject) {
    return new Vector3(...subject.referenceOffset)
      .applyQuaternion(new Quaternion(...pose.rotation))
      .add(new Vector3(...pose.position));
  }
  private resolve(request: ActionRequest) {
    if (
      request.device !== this.id ||
      request.runId !== this.config.runId ||
      !this.supports(request.behavior)
    )
      throw new Error("Foreign transport request");
    if (!Number.isInteger(request.arguments.subject_id))
      throw new Error("Subject ID requires integer");
    const subject = this.config.subjects.get(
        request.arguments.subject_id as number,
      ),
      authoredTarget = this.config.targets.find(
        (t) =>
          t.id ===
          (request.behavior === "transport_to_position"
            ? request.arguments.target
            : this.id + ".exit"),
      );
    if (!subject || !authoredTarget)
      throw new Error("Unknown transport subject/target");
    const target = structuredClone(authoredTarget);
    if (target.heightMode === "preserve_supported") {
      if (
        !this.config.drives.some((d) =>
          this.physics.hasSupport(subject.bodyId, d.surfaceId),
        )
      )
        throw new Error("Load has not reached its conveying support");
      const actual = this.point(
        this.physics.readBody!(subject.bodyId),
        subject,
      );
      // A belt controls longitudinal travel, not lateral centring or load height.
      const along = new Vector3(...target.position)
        .sub(actual)
        .dot(this.direction);
      target.position = actual.addScaledVector(this.direction, along).toArray();
    }
    const pose = this.physics.readBody!(subject.bodyId),
      delta = new Vector3(...target.position).sub(this.point(pose, subject)),
      distance = delta.dot(this.direction);
    const lateral = delta.clone().addScaledVector(this.direction, -distance);
    lateral.y = 0;
    if (
      distance < -this.config.positionTolerance ||
      lateral.length() > this.config.positionTolerance ||
      Math.abs(delta.y) > this.config.verticalTolerance
    )
      throw new Error(
        "Transport target is behind or outside the supported path",
      );
    return { subject, target };
  }
  private command(
    device: string,
    port: string,
    value: boolean | number,
    request?: ActionRequest,
  ): SignalWrite {
    return {
      key: `${this.config.sceneId}/${device}/${port}`,
      writer: "process",
      runId: this.config.runId,
      value,
      requestId: request?.requestId,
      activationId: request?.activationId,
      subjectId: request?.subjectId,
    };
  }
  sampleInputs(frame: Readonly<SceneSignalFrame>) {
    this.handshake.sample(frame);
  }
  prepare(source: ActionRequest, frame: Readonly<SceneSignalFrame>) {
    this.prepared = undefined;
    this.handshake.check(source, frame);
    const request = immutable(structuredClone(source));
    if (frame.runId !== this.config.runId)
      throw new Error("Foreign command frame");
    if (this.request && !this.terminal) throw new Error("Drive group is busy");
    if (this.error) throw new Error("Drive fault requires a reset/new run");
    if (
      request.device !== this.id ||
      request.runId !== this.config.runId ||
      !this.supports(request.behavior)
    )
      throw new Error("Foreign transport request");
    if (request.behavior === "stop_conveying") {
      if (Object.keys(request.arguments).length)
        throw new Error("Stop takes no arguments");
      this.prepared = { source, frozen: request };
      return [
        ...this.behaviorCodeCommand(request),
        ...this.stopCommands(request),
      ];
    }
    const resolved = this.resolve(request);
    this.prepared = { source, frozen: request, resolved };
    const { target } = resolved;
    return [
      ...this.behaviorCodeCommand(request),
      ...(this.config.subjectIdPort
        ? [
            this.command(
              this.id,
              this.config.subjectIdPort,
              Number(request.arguments.subject_id),
              request,
            ),
          ]
        : []),
      ...(this.config.releasePermissionPort
        ? [
            this.command(
              this.id,
              this.config.releasePermissionPort,
              request.behavior === "release_material",
              request,
            ),
          ]
        : []),
      ...this.config.drives.flatMap((d) => [
        this.command(
          d.device,
          "runTag",
          request.behavior !== "release_material",
          request,
        ),
        this.command(
          d.device,
          "speedTag",
          request.behavior === "release_material" ? 0 : this.config.maxSpeed,
          request,
        ),
      ]),
      this.command(this.id, "request_id", Number(request.requestId), request),
      this.command(this.id, "execute", true, request),
      ...(request.behavior === "transport_to_position"
        ? [this.command(this.id, "target_location", target.index, request)]
        : []),
    ];
  }
  private behaviorCodeCommand(request: ActionRequest): SignalWrite[] {
    const code = this.config.behaviorCodes?.[request.behavior];
    return code === undefined
      ? []
      : [this.command(this.id, "behavior_code", code, request)];
  }
  prepareCancel(request: ActionRequest, frame: Readonly<SceneSignalFrame>) {
    if (frame.runId !== this.config.runId)
      throw new Error("Foreign command frame");
    return this.stopCommands(request);
  }
  prepareStop(frame: Readonly<SceneSignalFrame>) {
    if (frame.runId !== this.config.runId)
      throw new Error("Foreign command frame");
    return this.stopCommands(this.request);
  }
  private stopCommands(request?: ActionRequest) {
    return [
      ...(this.config.releasePermissionPort
        ? [
            this.command(
              this.id,
              this.config.releasePermissionPort,
              false,
              request,
            ),
          ]
        : []),
      ...this.config.drives.flatMap((d) => [
        this.command(d.device, "runTag", false, request),
        this.command(d.device, "speedTag", 0, request),
      ]),
      this.command(this.id, "execute", false, request),
    ];
  }
  submit(source: ActionRequest) {
    if (this.prepared?.source !== source)
      throw new Error("Transport request not prepared");
    const { frozen: request, resolved } = this.prepared;
    this.prepared = undefined;
    this.handshake.submit(request);
    this.request = request;
    this.subject = resolved?.subject;
    this.target = resolved?.target;
    this.stopping = false;
    this.terminal = false;
    this.succeeded = false;
    this.settled = 0;
    this.error = "";
  }
  cancel(request: ActionRequest) {
    if (!this.handshake.matches(request))
      throw new Error("Cancel identity mismatch");
    this.requestStop();
  }
  requestStop() {
    this.stopping = true;
  }
  completedAt(subject: string, target: string) {
    return (
      this.terminal &&
      this.succeeded &&
      !this.error &&
      this.subject?.id === subject &&
      this.target?.id === target
    );
  }
  isStopped() {
    return (
      Math.abs(this.speed) <= this.config.speedTolerance &&
      this.config.drives.every(
        (d) =>
          Math.abs(this.physics.getSurfaceSpeed!(d.surfaceId)) <=
          this.config.speedTolerance,
      ) &&
      (!this.subject ||
        (this.succeeded &&
          this.physics.isBodyActive?.(this.subject.bodyId) === false) ||
        Math.hypot(...this.physics.readBody!(this.subject.bodyId).velocity) <=
          this.config.speedTolerance)
    );
  }
  beforePhysics(dt: number) {
    if (!this.stopping) {
      const acceptance = this.handshake.accept();
      if (acceptance) this.feedback.push(acceptance);
    }
    let demand = 0;
    if (
      this.request &&
      !this.stopping &&
      !this.terminal &&
      ["transport_to_position", "transport_to_exit"].includes(
        this.request.behavior,
      )
    ) {
      const position = this.point(
          this.physics.readBody!(this.subject!.bodyId),
          this.subject!,
        ),
        remaining = new Vector3(...this.target!.position)
          .sub(position)
          .dot(this.direction);
      if (remaining < -this.config.positionTolerance) {
        this.error = "Target overshoot";
        this.stopping = true;
      } else
        demand = Math.min(
          this.config.maxSpeed,
          Math.max(0, remaining) * 1.5,
          Math.sqrt(
            2 *
              this.config.deceleration *
              Math.max(0, remaining - this.config.positionTolerance / 2),
          ),
        );
    }
    const delta =
      (demand > this.speed
        ? this.config.acceleration
        : this.config.deceleration) * dt;
    this.speed +=
      Math.sign(demand - this.speed) *
      Math.min(Math.abs(demand - this.speed), delta);
    this.physics.setSurfaceSpeeds!(
      Object.fromEntries(
        this.config.drives.map((d) => [d.surfaceId, this.speed]),
      ),
    );
  }
  afterPhysics(dt: number, tick: number) {
    this.encoder += this.speed * dt;
    if (this.config.publishDriveState)
      this.observations.push({
        key: `${this.id}/drive_state`,
        provider: `adapter:${this.id}`,
        runId: this.config.runId,
        ...this.request,
        value: {
          maxSpeed: Math.max(
            ...this.config.drives.map((d) =>
              Math.abs(this.physics.getSurfaceSpeed!(d.surfaceId)),
            ),
          ),
          error: this.error || null,
        },
      });
    const loads = [...this.config.subjects].flatMap(([id, subject]) => {
      if (
        this.physics.isBodyActive &&
        !this.physics.isBodyActive(subject.bodyId)
      )
        return [];
      const pose = this.physics.readBody!(subject.bodyId);
      return [
        {
          id,
          subject: subject.id,
          position: this.point(pose, subject).toArray(),
          velocity: pose.velocity,
          supported: [
            ...this.config.drives.map((d) => d.surfaceId),
            ...(this.config.admissionSupportIds ?? []),
          ].some((s) => this.physics.hasSupport(subject.bodyId, s)),
        },
      ];
    });
    this.observations.push({
      runId: this.config.runId,
      key: `${this.id}/loads`,
      provider: `adapter:${this.id}`,
      value: loads,
    });
    if (
      this.request &&
      this.subject &&
      this.physics.isBodyActive?.(this.subject.bodyId) !== false
    ) {
      const pose = this.physics.readBody!(this.subject.bodyId),
        point = this.point(pose, this.subject),
        target = new Vector3(...this.target!.position);
      const supported = this.target!.supportIds.some((id) =>
        this.physics.hasSupport(this.subject!.bodyId, id),
      );
      const distance = point.distanceTo(target),
        stationary = this.isStopped();
      this.observations.push({
        key: `${this.id}/transport`,
        provider: `adapter:${this.id}`,
        value: {
          subject: this.subject.id,
          position: point.toArray(),
          target: this.target!.id,
          distance,
          supported,
          stationary,
        },
        ...this.request,
      });
      if (!this.terminal) {
        if (
          !this.stopping &&
          distance <= this.config.positionTolerance &&
          stationary &&
          supported
        ) {
          if (
            ++this.settled >= this.config.settleTicks &&
            (this.request.behavior !== "release_material" ||
              this.release!(this.subject, this.target!, tick))
          ) {
            this.succeed(this.request);
          }
        } else this.settled = 0;
        if (this.stopping && stationary) {
          this.terminal = true;
          if (this.error) this.handshake.finish(false);
          this.feedback.push({
            ...this.request,
            status: this.error ? "failed" : "stopped",
            reason: this.error || undefined,
          });
        }
      } else if (this.stopping && stationary)
        this.feedback.push({ ...this.request, status: "stopped" });
    }
    if (
      this.request?.behavior === "stop_conveying" &&
      !this.terminal &&
      this.isStopped()
    ) {
      if (this.stopping) {
        this.terminal = true;
        this.feedback.push({ ...this.request, status: "stopped" });
      } else if (++this.settled >= this.config.settleTicks) {
        this.succeed(this.request);
      }
    }
    const publish = (device: string, port: string, value: boolean | number) =>
      this.signals.push({
        key: `${this.config.sceneId}/${device}/${port}`,
        writer: `adapter:${device}`,
        runId: this.config.runId,
        value,
        requestId: this.request?.requestId,
        activationId: this.request?.activationId,
        subjectId: this.request?.subjectId,
      });
    for (const d of this.config.drives) {
      publish(
        d.device,
        "actual_speed",
        this.physics.getSurfaceSpeed!(d.surfaceId),
      );
      publish(d.device, "runningTag", this.speed > this.config.speedTolerance);
      publish(d.device, "encoderTag", this.encoder);
    }
    if (this.config.inventoryFeedback) {
      const io = this.config.inventoryFeedback,
        exit = this.config.targets.find((t) => t.id === this.id + ".exit");
      const onBelt = [...this.config.subjects.values()].filter(
        (s) =>
          this.physics.isBodyActive?.(s.bodyId) !== false &&
          this.config.drives.some((d) =>
            this.physics.hasSupport(s.bodyId, d.surfaceId),
          ),
      );
      const atExit =
        !!exit &&
        onBelt.some(
          (s) =>
            s.id === this.subject?.id &&
            Math.abs(
              new Vector3(...exit.position)
                .sub(this.point(this.physics.readBody!(s.bodyId), s))
                .dot(this.direction),
            ) <= this.config.positionTolerance &&
            Math.hypot(...this.physics.readBody!(s.bodyId).velocity) <=
              this.config.speedTolerance,
        );
      publish(this.id, io.partReadyPort, atExit);
      publish(this.id, io.capacityPort, onBelt.length < io.capacity);
    }
    this.signals.push(...this.handshake.publish());
    publish(this.id, "busy", !!this.request && !this.terminal);
    publish(this.id, "error", !!this.error);
    publish(this.id, "error_code", this.error ? 1 : 0);
  }
  private succeed(request: ActionRequest) {
    this.terminal = true;
    this.succeeded = true;
    this.config.onSucceeded?.(request);
    this.handshake.finish(true);
    this.feedback.push({ ...request, status: "succeeded" });
  }
  acknowledge(feedback: ActionFeedback, frame: Readonly<SceneSignalFrame>) {
    return this.handshake.acknowledge(feedback, frame);
  }
  drainFeedback() {
    return this.feedback.splice(0);
  }
  drainSignals() {
    return this.signals.splice(0);
  }
  drainObservations() {
    return this.observations.splice(0);
  }
  dispose() {
    if (!this.isStopped()) throw new Error("Drive group still moving");
  }
}

interface ConveyorGroupOptions {
  leader: string;
  members: string[];
  eligible: string[];
  targetLocations: ReadonlyMap<
    string,
    { position: Vec3; supportDevice: string }
  >;
  supplySupports: string[];
  palletExit?: string;
  releasePallet(id: string, target: TransportTarget, tick: number): boolean;
}
export function createConveyorGroup(
  sceneId: string,
  runId: string,
  c: CompiledSceneRuntime,
  physics: PhysicsPort,
  options: ConveyorGroupOptions,
) {
  const { leader: id, members, eligible, palletExit } = options;
  const group = c.devices.get(id)!;
  if (
    group.contract.device_type !== "conveyor" ||
    group.contract.version !== "1.2.0"
  )
    throw new Error("Unsupported pallet-line conveyor: " + id);
  const subjects = new Map<number, TransportSubject>();
  for (const name of eligible) {
    const body = bodyOf(c, name),
      index = c.subjectIds.get(name);
    if (!index) throw new Error("Missing transport subject ID: " + name);
    const referenceOffset: Vec3 = palletExit
      ? originOffset(c.devices.get(name)!, body).toArray()
      : [0, -body.size[1] / 2, 0];
    subjects.set(index, { id: name, bodyId: body.id, referenceOffset });
  }
  const drives = members.map((m) => {
    const device = c.devices.get(m)!;
    if (
      device.parameters.speed_mps !== group.parameters.speed_mps ||
      device.parameters.accel_time_s !== group.parameters.accel_time_s ||
      device.parameters.decel_time_s !== group.parameters.decel_time_s
    )
      throw new Error("Coupled conveyors have different ramp parameters");
    const surface = c.physics.surfaces?.find(
      (s) => s.id === m + "/surface" || s.aliases?.includes(m + "/surface"),
    );
    if (!surface) throw new Error("Drive is missing a physical surface: " + m);
    return { device: m, surfaceId: m + "/surface", flow: surface.direction };
  });
  const targets: TransportTarget[] = [];
  for (const [name, point] of options.targetLocations) {
    if (!name.startsWith(id + ".") || !members.includes(point.supportDevice))
      continue;
    const position = new Vector3(...point.position);
    if (name === palletExit) {
      const dir = new Vector3(...drives[0].flow);
      // Stop with the full carrier supported before passing it to the receiver.
      const inset = Math.max(
        ...eligible.map((p) => {
          const body = bodyOf(c, p),
            o = originOffset(c.devices.get(p)!, body);
          return (
            0.5 *
              body.size.reduce(
                (sum, d, i) => sum + d * Math.abs(dir.toArray()[i]),
                0,
              ) -
            o.dot(dir)
          );
        }),
      );
      position.addScaledVector(dir, -inset - 0.015);
    }
    targets.push({
      id: name,
      index: targets.length + 1,
      position: position.toArray(),
      supportIds: [point.supportDevice + "/surface"],
    });
  }
  const speed = Number(group.parameters.speed_mps);
  const cfg: PositionTransportConfig = {
    sceneId,
    runId,
    leader: id,
    drives,
    subjects,
    targets,
    publishDriveState: true,
    admissionSupportIds: options.supplySupports,
    maxSpeed: speed,
    acceleration: speed / Number(group.parameters.accel_time_s),
    deceleration: speed / Number(group.parameters.decel_time_s),
    positionTolerance: 0.015,
    verticalTolerance: 0.03,
    speedTolerance: 0.02,
    settleTicks: 3,
    inventoryFeedback: {
      partReadyPort: "part_ready",
      capacityPort: "capacity_available",
      capacity: Number(group.parameters.capacity),
    },
    releasePermissionPort: "release_waiting_material",
  };
  const belt = new PositionTransportAdapter(
    cfg,
    physics,
    palletExit
      ? (load, t, tick) => options.releasePallet(load.id, t, tick)
      : undefined,
  );
  return { belt, cfg };
}

interface ExitReading {
  supported: boolean;
  held: boolean;
  pose: BodyPose;
  atExit: boolean;
  stationary: boolean;
}

/** 独立输送带的到达契约读取实际源面、运动方向和冻结回执，启停信号采用同一实例的信号表。 */
export function bindExitConditions<W extends ExitReading>(
  port: DeviceConditionBindings<W>,
  driver: PositionTransportAdapter,
  config: {
    material: string;
    location: string;
    target: Vec3;
    flow: Vec3;
    positionTolerance: number;
    speed: number;
  },
) {
  port.register(
    "device_ready",
    (_, ctx) => port.signal("error", ctx) === false && driver.isStopped(),
  );
  port.register("subject_on_conveyor", (w) => w.supported && !w.held);
  port.register(
    "transport_path_valid",
    (w) =>
      w.supported &&
      !w.held &&
      new Vector3(...config.target)
        .sub(new Vector3(...w.pose.position))
        .dot(new Vector3(...config.flow)) >= -config.positionTolerance,
  );
  port.register(
    "speed_setpoint_valid",
    () => Number.isFinite(config.speed) && config.speed > 0,
  );
  port.register(
    "run_permission",
    (_, ctx) => port.signal("runTag", ctx) === true,
  );
  port.register(
    "exit_arrival_confirmed",
    (w, ctx) =>
      w.supported &&
      w.atExit &&
      w.stationary &&
      driver.completedAt(config.material, config.location) &&
      ctx.requestState?.outcome === "succeeded",
  );
  port.register("stopped", () => driver.isStopped());
}

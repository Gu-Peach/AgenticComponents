import { Vector3, Quaternion } from "three";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import type { ActionRequest, ActionFeedback } from "@/contracts/scheduler";
import type { SceneSignalFrame, SignalWrite } from "@/contracts/scene-signals";
import type { ObservationWrite } from "@/contracts/conditions";
import type { DeviceActionPort } from "./DeviceActionPort";

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
  private accepted = false;
  private acknowledged = false;
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
  prepare(request: ActionRequest, frame: Readonly<SceneSignalFrame>) {
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
      return this.stopCommands(request);
    }
    const { target } = this.resolve(request);
    return [
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
  submit(request: ActionRequest) {
    if (this.request && !this.terminal)
      throw new Error("Drive group already executing");
    if (
      request.device !== this.id ||
      request.runId !== this.config.runId ||
      !this.supports(request.behavior)
    )
      throw new Error("Foreign transport request");
    const resolved =
      request.behavior === "stop_conveying" ? undefined : this.resolve(request);
    this.request = request;
    this.subject = resolved?.subject;
    this.target = resolved?.target;
    this.stopping = false;
    this.terminal = false;
    this.succeeded = false;
    this.settled = 0;
    this.error = "";
    this.accepted = false;
    this.acknowledged = false;
  }
  cancel(request: ActionRequest) {
    if (this.request?.requestId !== request.requestId)
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
    if (this.request && !this.accepted && !this.stopping) {
      this.feedback.push({ ...this.request, status: "accepted" });
      this.accepted = true;
    }
  }
  afterPhysics(dt: number, tick: number) {
    this.encoder += this.speed * dt;
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
            this.terminal = true;
            this.succeeded = true;
            this.feedback.push({ ...this.request, status: "succeeded" });
          }
        } else this.settled = 0;
        if (this.stopping && stationary) {
          this.terminal = true;
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
        this.terminal = true;
        this.succeeded = true;
        this.feedback.push({ ...this.request, status: "succeeded" });
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
    publish(this.id, "accepted", this.accepted && !this.acknowledged);
    publish(this.id, "busy", !!this.request && !this.terminal);
    publish(this.id, "done", this.succeeded && !this.error);
    publish(
      this.id,
      "result_id",
      this.request ? Number(this.request.requestId) : 0,
    );
    publish(this.id, "error", !!this.error);
    publish(this.id, "error_code", this.error ? 1 : 0);
  }
  acknowledge(feedback: ActionFeedback, frame: Readonly<SceneSignalFrame>) {
    if (frame.runId !== this.config.runId)
      throw new Error("Foreign command frame");
    if (
      feedback.status !== "accepted" ||
      feedback.runId !== this.config.runId ||
      feedback.requestId !== this.request?.requestId
    )
      return [];
    this.acknowledged = true;
    return [this.command(this.id, "execute", false, this.request)];
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

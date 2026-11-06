import type { ActionRequest, ActionFeedback } from "@/contracts/scheduler";
import type { CompiledRobotScene } from "@/contracts/robot";
import { robotCommandSchema, type RobotStep } from "@/contracts/robot-command";
import type { PhysicsPort } from "@/contracts/physics";
import type { SceneSignalFrame, SignalWrite } from "@/contracts/scene-signals";
import type { ObservationWrite } from "@/contracts/conditions";
import { SignalRegistry } from "@/runtime/engine/SignalRegistry";
import { RobotJobRunner } from "@/runtime/templates/robot/RobotJobRunner";
import { RobotState } from "@/runtime/templates/robot/RobotState";
import type { DeviceActionPort } from "./DeviceActionPort";
export interface PreparedRobotAction {
  scene: CompiledRobotScene;
  steps: RobotStep[];
}
/** Reuses the existing FK/IK/trajectory/grasp runner while the scene owns physics.step. */
export class RobotSceneAdapter implements DeviceActionPort {
  readonly id: string;
  private state = new RobotState();
  private runner?: RobotJobRunner;
  private request?: ActionRequest;
  private prepared?: { id: string; runner: RobotJobRunner; state: RobotState };
  private terminal = false;
  private succeeded = false;
  private acknowledged = false;
  private stopping = false;
  private error = "";
  private feedback: ActionFeedback[] = [];
  private signals: SignalWrite[] = [];
  private observations: ObservationWrite[] = [];
  private localSignals = new SignalRegistry([
    { id: "enableTag", direction: "input", type: "BOOL" },
  ]);
  constructor(
    private sceneId: string,
    private runId: string,
    private base: CompiledRobotScene,
    private physics: PhysicsPort,
    private resolve: (request: ActionRequest) => PreparedRobotAction,
  ) {
    this.id = base.instanceId;
    if (!physics.readBody || !physics.moveTool)
      throw new Error("Robot needs addressed scene physics");
    this.localSignals.command("enableTag", true);
    this.localSignals.begin(0);
  }
  supports(behavior: string) {
    return behavior === "pick_and_place" || behavior === "move_to_pose";
  }
  private write(
    port: string,
    value: boolean | number,
    request?: ActionRequest,
  ): SignalWrite {
    return {
      key: `${this.sceneId}/${this.id}/${port}`,
      writer: "process",
      runId: this.runId,
      value,
      requestId: request?.requestId,
      activationId: request?.activationId,
      subjectId: request?.subjectId,
    };
  }
  prepare(request: ActionRequest, frame: Readonly<SceneSignalFrame>) {
    if (frame.runId !== this.runId) throw new Error("Foreign command frame");
    if (
      request.device !== this.id ||
      request.runId !== this.runId ||
      !this.supports(request.behavior) ||
      (this.request && !this.terminal) ||
      this.runner?.grasp?.holding
    )
      throw new Error("Robot cannot admit this action");
    if (this.error || !this.isStopped())
      throw new Error("Robot must be stopped and fault-free before admission");
    const action = structuredClone(this.resolve(request));
    if (
      action.scene.instanceId !== this.id ||
      action.scene.toolBodyId !== this.base.toolBodyId
    )
      throw new Error("Robot resolver changed device identity");
    const command = robotCommandSchema.parse({
      instanceId: this.id,
      requestId: Number(request.requestId),
      behaviorId: request.behavior,
      steps: action.steps,
    });
    if (
      command.steps.some(
        (s) => !["move_to_pose", "grip", "release"].includes(s.kind),
      )
    )
      throw new Error(
        "Scene robot adapter supports pose/grasp transfer steps only",
      );
    const state = new RobotState();
    state.q = [...this.state.q];
    state.qdot = [...this.state.qdot];
    const port: PhysicsPort = {
      ...this.physics,
      setSurfaceSpeed: (v) => this.physics.setSurfaceSpeed(v),
      step: () => {
        throw new Error("Device runner must not step the world");
      },
      readMaterial: () => {
        if (!action.scene.materialBodyId)
          throw new Error("No material in current request");
        return this.physics.readBody!(action.scene.materialBodyId);
      },
      hasSupport: (b, s) => this.physics.hasSupport(b, s),
      readBody: (id) => this.physics.readBody!(id),
      moveTool: (id, p, dt) => this.physics.moveTool!(id, p, dt),
      createGrasp: (id, t, m) => this.physics.createGrasp!(id, t, m),
      removeGrasp: (id) => this.physics.removeGrasp!(id),
      hasGrasp: (id) => this.physics.hasGrasp!(id),
      dispose: () => {
        throw new Error("Device runner must not dispose world");
      },
    };
    const runner = new RobotJobRunner(
      action.scene,
      state,
      this.localSignals,
      port,
    );
    runner.plan(command.steps);
    this.prepared = { id: request.requestId, runner, state };
    return [
      this.write("enableTag", true, request),
      this.write("start_pick", true, request),
      this.write("request_id", Number(request.requestId), request),
    ];
  }
  submit(request: ActionRequest) {
    if (this.prepared?.id !== request.requestId)
      throw new Error("Robot action not prepared");
    this.runner?.dispose();
    this.runner = this.prepared.runner;
    this.state = this.prepared.state;
    this.prepared = undefined;
    this.request = request;
    this.terminal = false;
    this.succeeded = false;
    this.acknowledged = false;
    this.stopping = false;
    this.error = "";
    this.localSignals.command("enableTag", true);
    this.feedback.push({ ...request, status: "accepted" });
  }
  prepareCancel(request: ActionRequest, frame: Readonly<SceneSignalFrame>) {
    if (frame.runId !== this.runId) throw new Error("Foreign command frame");
    return [
      this.write("enableTag", false, request),
      this.write("start_pick", false, request),
    ];
  }
  prepareStop(frame: Readonly<SceneSignalFrame>) {
    if (frame.runId !== this.runId) throw new Error("Foreign command frame");
    return this.prepareCancel(
      this.request ?? {
        runId: this.runId,
        device: this.id,
        activationId: "",
        requestId: "0",
        behavior: "stop",
        arguments: {},
      },
      frame,
    );
  }
  cancel(request: ActionRequest) {
    if (this.request?.requestId !== request.requestId)
      throw new Error("Robot cancel identity mismatch");
    this.requestStop();
  }
  requestStop() {
    this.stopping = true;
    this.localSignals.command("enableTag", false);
  }
  isStopped() {
    return (
      !this.runner?.grasp?.holding &&
      this.state.qdot.every((v) => Math.abs(v) <= this.base.settleSpeed) &&
      Math.hypot(...this.physics.readBody!(this.base.toolBodyId).velocity) <=
        0.02
    );
  }
  beforePhysics(dt: number, tick: number) {
    this.localSignals.begin(tick);
    this.runner?.before(dt);
  }
  afterPhysics(dt: number, tick: number) {
    if (this.request && this.runner) {
      try {
        this.runner.after(dt, tick);
      } catch (e) {
        this.error = String(e);
        this.requestStop();
        if (!this.terminal) {
          this.feedback.push({
            ...this.request,
            status: "failed",
            reason: this.error,
          });
          this.terminal = true;
        }
      }
      const measured = this.physics.readBody!(this.base.toolBodyId),
        tcp = this.runner.tcp;
      const physicallyAtTCP =
        Math.hypot(...measured.position.map((v, i) => v - tcp.position[i])) <=
        this.base.tolerance;
      if (
        !this.terminal &&
        !this.stopping &&
        this.runner.finished &&
        physicallyAtTCP &&
        this.isStopped()
      ) {
        this.feedback.push({ ...this.request, status: "succeeded" });
        this.terminal = true;
        this.succeeded = true;
      }
      if (this.stopping && this.isStopped() && !this.runner.grasp?.holding) {
        this.feedback.push({ ...this.request, status: "stopped" });
        this.terminal = true;
      }
      this.observations.push({
        ...this.request,
        key: `${this.id}/robot_state`,
        provider: `adapter:${this.id}`,
        value: {
          q: [...this.state.q],
          qdot: [...this.state.qdot],
          tcp: this.runner.tcp,
          tool: this.physics.readBody!(this.base.toolBodyId),
          holding: !!this.runner.grasp?.holding,
          phase: this.state.phase,
        },
      });
    }
    const values = {
      accepted: !!this.request && !this.acknowledged,
      busy: !!this.request && !this.terminal,
      done: this.succeeded && !this.error,
      error: !!this.error,
      error_code: this.error ? 1 : 0,
      result_id: this.request ? Number(this.request.requestId) : 0,
      holding_material: !!this.runner?.grasp?.holding,
    };
    for (const [port, value] of Object.entries(values))
      this.signals.push({
        key: `${this.sceneId}/${this.id}/${port}`,
        writer: `adapter:${this.id}`,
        runId: this.runId,
        value,
        requestId: this.request?.requestId,
        activationId: this.request?.activationId,
        subjectId: this.request?.subjectId,
      });
  }
  acknowledge(feedback: ActionFeedback, frame: Readonly<SceneSignalFrame>) {
    if (frame.runId !== this.runId) throw new Error("Foreign command frame");
    if (
      feedback.status !== "accepted" ||
      feedback.runId !== this.runId ||
      feedback.requestId !== this.request?.requestId
    )
      return [];
    this.acknowledged = true;
    return [this.write("start_pick", false, this.request)];
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
    if (!this.isStopped() || this.runner?.grasp?.holding)
      throw new Error("Robot still moving or holding material");
    this.runner?.dispose();
  }
}

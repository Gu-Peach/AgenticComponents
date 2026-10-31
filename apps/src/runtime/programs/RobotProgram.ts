import { Vector3, Quaternion } from "three";
import type { CompiledRobotScene } from "@/contracts/robot";
import {
  robotCommandSchema,
  type RobotCommand,
  type RobotStep,
} from "@/contracts/robot-command";
import type { PhysicsPort } from "@/contracts/physics";
import type { RuntimeProgram } from "@/contracts/runtime-program";
import type { RuntimeSnapshot } from "@/contracts/runtime";
import {
  SignalRegistry,
  type SignalDefinition,
} from "@/runtime/engine/SignalRegistry";
import { RequestLedger } from "@/runtime/engine/RequestLedger";
import { registerTemplates } from "@/runtime/templates/registerTemplates";
export class RobotProgram implements RuntimeProgram {
  readonly signals: SignalRegistry;
  private ledger = new RequestLedger();
  private script;
  private tick = 0;
  private elapsed = 0;
  private disposed = false;
  private behaviorId = "";
  private current: RuntimeSnapshot;
  constructor(
    readonly scene: CompiledRobotScene,
    private physics?: PhysicsPort,
  ) {
    const ports: SignalDefinition[] = [
      ...["enableTag", "pause_pick", "reset", "start_pick"].map((id) => ({
        id,
        direction: "input" as const,
        type: "BOOL" as const,
      })),
      ...["commandTag", "request_id"].map((id) => ({
        id,
        direction: "input" as const,
        type: id === "request_id" ? ("DINT" as const) : ("INT" as const),
      })),
      ...["accepted", "busy", "done", "error", "holding_material"].map(
        (id) => ({ id, direction: "output" as const, type: "BOOL" as const }),
      ),
      { id: "result_id", direction: "output", type: "DINT" },
      { id: "error_code", direction: "output", type: "INT" },
    ];
    for (let i = 1; i <= 4; i++)
      ports.push(
        { id: `in${i}Tag`, direction: "input", type: "BOOL" },
        { id: `out${i}Tag`, direction: "output", type: "BOOL" },
      );
    this.signals = new SignalRegistry(ports, scene.instanceId);
    for (const [k, v] of Object.entries({
      enableTag: true,
      pause_pick: false,
      reset: false,
      start_pick: false,
      request_id: 0,
      commandTag: 0,
    }))
      this.signals.command(k, v);
    this.signals.begin(0);
    this.script = registerTemplates()
      .get("robot.articulated")
      .create(scene, this.signals, physics);
    this.current = {
      status: "ready",
      kind: "robot_experiment",
      tick: 0,
      time: 0,
      instanceId: scene.instanceId,
      subjectId: scene.subjectId,
      materialInstanceId: scene.materialInstanceId,
      bodyLocalMatrix: scene.bodyLocalMatrix,
      signals: {},
      supported: false,
      atExit: false,
      request: null,
    };
    this.feedback();
  }
  submitAction(raw: RobotCommand) {
    if (this.disposed) throw new Error("会话已结束");
    const c = robotCommandSchema.parse(raw);
    if (c.instanceId !== this.scene.instanceId)
      throw new Error("请求机械臂不属于本会话");
    if (this.script.state.error) throw new Error("请先复位故障");
    if (this.ledger.request?.status === "busy") throw new Error("已有执行任务");
    if (this.signals.nextInput("enableTag") !== true)
      throw new Error("机械臂未使能");
    if (
      this.signals.nextInput("pause_pick") === true &&
      (c.behaviorId === "pick_and_place" ||
        c.steps.some((s) => s.kind === "grip"))
    )
      throw new Error("抓取接单已暂停");
    if (this.ledger.request?.requestId === String(c.requestId))
      throw new Error("重复请求");
    this.ledger.assertAvailable(String(c.requestId));
    this.script.runner.plan(structuredClone(c.steps));
    this.ledger.accept(
      String(c.requestId),
      this.scene.subjectId ?? this.scene.instanceId,
    );
    this.behaviorId = c.behaviorId;
    this.elapsed = 0;
    this.signals.command("request_id", c.requestId);
    this.signals.command("start_pick", true);
    for (let i = 1; i <= 4; i++)
      this.signals.publish(`out${i}Tag`, false, this.tick);
    this.signals.publish("accepted", true, this.tick);
    this.feedback();
  }
  command(id: string, value: boolean | number) {
    if (["start_pick", "request_id", "commandTag"].includes(id))
      throw new Error("任务握手由统一命令网关写入");
    this.signals.command(id, value);
  }
  pickPlaceCommand(requestId: number): RobotCommand {
    const s = this.scene;
    if (
      !this.physics ||
      !s.materialInstanceId ||
      !s.placementCenter ||
      !s.materialSize
    )
      throw new Error("请选择物料和目标支承并准备物理实验");
    const p = this.physics.readMaterial(),
      offset = new Vector3(0, s.materialSize[1] / 2 + 0.025, 0),
      pick = new Vector3(...p.position).add(
        offset.clone().applyQuaternion(new Quaternion(...p.rotation)),
      );
    const move = (v: Vector3, held = false, clearance = false): RobotStep => ({
      kind: "move_to_pose",
      position: v.toArray(),
      frame: "world",
      subject: held ? "held_material" : "tcp",
      support_clearance: clearance,
    });
    const center = new Vector3(...p.position),
      place = new Vector3(...s.placementCenter);
    return {
      requestId,
      instanceId: s.instanceId,
      behaviorId: "pick_and_place",
      steps: [
        move(pick.clone().add(new Vector3(0, s.liftHeight, 0))),
        move(pick),
        { kind: "grip", materialId: s.materialInstanceId },
        move(center.clone().add(new Vector3(0, s.liftHeight, 0)), true),
        move(place.clone().add(new Vector3(0, s.liftHeight, 0)), true),
        move(place, true, true),
        { kind: "release", materialId: s.materialInstanceId },
        move(pick.clone().add(new Vector3(0, s.liftHeight * 2, 0))),
      ],
    };
  }
  step(dt: number) {
    if (this.disposed) throw new Error("会话已结束");
    this.tick++;
    this.signals.begin(this.tick);
    if (
      this.signals.peek("reset") === true &&
      this.ledger.request?.status !== "busy"
    ) {
      if (
        this.script.state.qdot.every(
          (v) => Math.abs(v) <= this.scene.settleSpeed,
        ) &&
        (!this.script.runner.grasp?.holding ||
          this.script.runner.grasp.error(this.script.runner.tcp) <=
            this.scene.model.gripper.constraint_tolerance_m)
      ) {
        this.script.state.error = "";
        this.signals.publish("error", false, this.tick);
        this.signals.publish("error_code", 0, this.tick);
      }
      this.signals.command("reset", false);
    }
    try {
      this.script.runner.before(dt);
      this.physics?.step(dt);
      if (this.ledger.request?.status === "busy") {
        if (
          this.signals.peek("enableTag") === true &&
          !this.script.state.holding
        )
          this.elapsed += dt;
        if (this.elapsed > this.scene.taskTimeout)
          throw new Error("机器人任务执行超时");
        this.script.runner.after(dt, this.tick);
        if (this.script.runner.finished) this.ledger.finish();
      }
    } catch (e) {
      this.script.state.error = e instanceof Error ? e.message : String(e);
      this.ledger.finish(this.script.state.error);
      this.signals.command("enableTag", false);
    }
    if (this.signals.peek("start_pick") === true) {
      this.signals.publish("accepted", true, this.tick);
      this.signals.command("start_pick", false);
    } else this.signals.publish("accepted", false, this.tick);
    this.feedback();
    return this.snapshot();
  }
  private feedback() {
    const r = this.ledger.request,
      s = this.script.state;
    if (this.tick === 0 && !r)
      this.signals.publish("accepted", false, this.tick);
    for (const [id, value] of Object.entries({
      busy: r?.status === "busy",
      done: r?.status === "succeeded",
      error: !!s.error,
      result_id: r ? Number(r.requestId) : 0,
      error_code: s.error ? 1 : 0,
      holding_material: !!this.script.runner.grasp?.holding,
    }))
      this.signals.publish(id, value, this.tick);
    const tcp = this.script.runner.tcp;
    const material = this.physics?.readMaterial();
    const capture =
      material && this.scene.materialSize
        ? new Vector3(0, this.scene.materialSize[1] / 2 + 0.025, 0)
            .applyQuaternion(new Quaternion(...material.rotation))
            .add(new Vector3(...material.position))
        : null;
    const authorization =
      !!this.scene.materialBodyId && !!this.scene.supportSurfaceId;
    this.current = {
      ...this.current,
      status: this.tick ? "running" : "ready",
      tick: this.tick,
      time: this.tick / 60,
      request: r ? { ...r } : null,
      signals: this.signals.snapshot(),
      pose: this.physics?.readMaterial(),
      supported: this.physics?.hasSupport() ?? false,
      robot: {
        q: [...s.q],
        qdot: [...s.qdot],
        tcp,
        phase: s.error ? "fault" : r?.status === "succeeded" ? "done" : s.phase,
        errorM: s.errorM,
        ik: s.ik
          ? {
              converged: s.ik.converged,
              error: s.ik.error,
              iterations: s.ik.iterations,
            }
          : null,
        holdingMaterialId: this.script.runner.grasp?.holding
          ? (this.scene.materialInstanceId ?? null)
          : null,
        constraintErrorM: this.script.runner.grasp?.error(tcp) ?? 0,
        mode: this.physics ? "fixed_grasp" : "kinematic_preview",
        calibrationSource: this.scene.model.calibration.source,
        authorizations: {
          source_authorized: authorization ? true : null,
          target_reserved: authorization ? true : null,
        },
        observations: {
          ...s.observations,
          kinematics_ready: true,
          device_idle: r?.status !== "busy",
          tool_empty: !this.script.runner.grasp?.holding,
          holding_material: !!this.script.runner.grasp?.holding,
          target_valid: r ? true : null,
          material_in_capture: capture
            ? capture.distanceTo(new Vector3(...tcp.position)) <=
              this.scene.model.gripper.capture_radius_m
            : null,
          payload_compatible: this.scene.materialMass
            ? this.scene.materialMass <= this.scene.maxPayload
            : null,
          release_pose_valid:
            material && this.scene.placementCenter
              ? new Vector3(...material.position).distanceTo(
                  new Vector3(...this.scene.placementCenter),
                ) <= 0.12
              : null,
          "execute_job.succeeded": r?.status === "succeeded",
          "pick_and_place.succeeded":
            this.behaviorId === "pick_and_place" && r?.status === "succeeded",
          "pause_pick_intake.succeeded":
            this.signals.peek("pause_pick") === true,
          "resume_pick_intake.succeeded":
            this.signals.peek("pause_pick") === false,
          "hold_motion.succeeded":
            s.holding &&
            s.qdot.every((v) => Math.abs(v) <= this.scene.settleSpeed),
          "resume_motion.succeeded":
            !s.holding && this.signals.peek("enableTag") === true,
        },
      },
      error: s.error || undefined,
    };
  }
  snapshot() {
    return structuredClone(this.current);
  }
  stop() {
    if (!this.disposed) {
      this.ledger.cancel();
      this.script.runner.dispose();
      this.physics?.dispose();
      this.disposed = true;
      this.current = {
        ...this.current,
        status: "stopped",
        request: this.ledger.request,
        signals: {
          ...this.current.signals,
          busy: {
            value: false,
            valid: true,
            tick: this.tick,
            writer: "engine",
          },
        },
      };
    }
    return this.snapshot();
  }
}

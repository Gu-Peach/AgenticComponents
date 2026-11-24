import type { MaterialGraspFrames } from "@/contracts/material-frames";
import { handoffBehavior } from "@/contracts/robot-handoff";
import {
  worldGraspFrame,
  selectGraspFrame,
} from "@/domain/runtime/materialGraspFrames";
import type { MaterialPoseObserver } from "@/runtime/engine/MaterialPoseObserver";
/** 机械臂的单机命令、关节轨迹、抓放、双臂交接与工具加工。驱动状态按实例及运行会话创建。 */
import { Matrix4, Quaternion, Vector3 } from "three";
import type { CompiledRobotScene } from "@/contracts/robot";
import type {
  BodyPose,
  PhysicsPort,
  RuntimeBody,
  Quat,
} from "@/contracts/physics";
import type { RuntimeProgram } from "@/contracts/runtime-program";
import type { RuntimeSnapshot } from "@/contracts/runtime";
import type { SceneDevice, Vec3 } from "@/contracts/scene-execution";
import type { ActionRequest, ActionFeedback } from "@/contracts/scheduler";
import type { SceneSignalFrame, SignalWrite } from "@/contracts/scene-signals";
import type {
  ObservationWrite,
  ConditionContext,
  DeviceConditionBindings,
  Truth,
} from "@/contracts/conditions";
import {
  robotCommandSchema,
  type RobotCommand,
  type RobotStep,
} from "@/contracts/robot-command";
import { RobotPlanError } from "@/runtime/kinematics/RobotPlanError";
import { RobotKinematics } from "@/runtime/kinematics/RobotKinematics";
import type { IKResult } from "@/runtime/kinematics/PositionIK";
import { CcdPositionIK } from "@/runtime/kinematics/CcdPositionIK";
import { DampedPoseIK } from "@/runtime/kinematics/DampedPoseIK";
import { restJointTarget } from "@/runtime/kinematics/restJointTarget";
import { DeviceRequestLatch } from "@/runtime/engine/DeviceRequestLatch";
import { immutable } from "@/runtime/scheduler/expressions";
import { JointTrajectory } from "@/runtime/mechanisms/JointTrajectory";
import {
  SignalRegistry,
  type SignalDefinition,
} from "@/runtime/engine/SignalRegistry";
import { RequestLedger } from "@/runtime/engine/RequestLedger";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import {
  WarehouseActionAdapter,
  type WarehouseJob,
} from "@/runtime/adapters/scene/WarehouseActionAdapter";

/** 保存机械臂任务执行中的关节角、角速度、当前阶段、逆运动学结果和误差，供执行器更新和读取。 */
export class RobotState {
  q = [0, 0, 0, 0, 0, 0];
  qdot = [0, 0, 0, 0, 0, 0];
  phase = "idle";
  errorM = 0;
  ik: IKResult | null = null;
  observations: Record<string, boolean | number | null> = {};
  held = false;
  holding = false;
  error = "";
}

/** 根据物料身份、载荷、捕获距离和相对速度建立抓取约束，检测持件偏移，释放后核实物料是否稳定放置。 */
function captureFrame(
  scene: CompiledRobotScene,
  pose: BodyPose,
  name?: string,
) {
  if (scene.materialGraspFrames)
    return worldGraspFrame(scene.materialGraspFrames, name, pose, 0.025);
  if (name !== undefined) throw new Error("物料未声明抓取接口: " + name);
  const rotation = new Quaternion(...pose.rotation);
  return {
    outward: new Vector3(0, 1, 0).applyQuaternion(rotation),
    tcp: new Vector3(0, scene.materialSize![1] / 2 + 0.025, 0)
      .applyQuaternion(rotation)
      .add(new Vector3(...pose.position)),
  };
}

export class GraspService {
  private binding?: Matrix4;
  private constraintId: string;
  constructor(
    private scene: CompiledRobotScene,
    private physics: PhysicsPort,
    private placementCheck?: () => boolean,
  ) {
    this.constraintId = `${scene.instanceId}/grasp`;
  }
  get holding() {
    return !!this.binding && !!this.physics.hasGrasp?.(this.constraintId);
  }
  get relative() {
    return this.binding?.clone();
  }
  grip(tcp: BodyPose, materialId: string, frame?: string) {
    const s = this.scene,
      g = s.model.gripper;
    if (
      materialId !== s.materialInstanceId ||
      !s.materialBodyId ||
      !s.materialMass ||
      s.materialMass > s.maxPayload
    )
      throw new Error("抓取身份或载荷不合法");
    if (this.holding) throw new Error("夹具已经持有物料");
    const p = this.physics.readMaterial(),
      capture = captureFrame(s, p, frame);
    const axis = s.model.tooling.approach_axis_local;
    if (
      s.materialGraspFrames &&
      axis &&
      new Vector3(...axis)
        .applyQuaternion(new Quaternion(...tcp.rotation))
        .dot(capture.outward) > -0.985
    )
      throw new Error("工具未沿选定抓取接口对准");
    if (
      capture.tcp.distanceTo(new Vector3(...tcp.position)) > g.capture_radius_m
    )
      throw new Error("物料不在捕获区域");
    if (
      new Vector3(...p.velocity).sub(new Vector3(...tcp.velocity)).length() >
      g.max_relative_speed_mps
    )
      throw new Error("抓取相对速度过高");
    if (!this.physics.createGrasp) throw new Error("物理固定约束未实现");
    this.physics.createGrasp(this.constraintId, s.toolBodyId, s.materialBodyId);
    this.binding = poseMatrix(tcp).invert().multiply(poseMatrix(p));
  }
  error(tcp: BodyPose) {
    if (!this.binding) return 0;
    const expected = poseMatrix(tcp).multiply(this.binding),
      p = this.physics.readMaterial();
    const pos = new Vector3(),
      q = new Quaternion();
    expected.decompose(pos, q, new Vector3());
    return Math.max(
      pos.distanceTo(new Vector3(...p.position)),
      q.angleTo(new Quaternion(...p.rotation)) * 0.1,
    );
  }
  release(materialId: string) {
    if (materialId !== this.scene.materialInstanceId || !this.holding)
      throw new Error("未持有指定物料");
    this.physics.removeGrasp?.(this.constraintId);
    this.binding = undefined;
  }
  placed() {
    if (this.placementCheck) return !this.holding && this.placementCheck();
    const s = this.scene;
    if (!s.placementCenter) return false;
    const p = this.physics.readMaterial(),
      q = new Quaternion(...p.rotation),
      support = s.physics!.bodies!.find((b) => b.role === "conveying_support")!;
    const local = new Vector3(...p.position)
      .sub(new Vector3(...support.position))
      .applyQuaternion(new Quaternion(...support.rotation).invert());
    const relative = new Quaternion(...support.rotation).invert().multiply(q),
      half = new Vector3(...s.materialSize!).multiplyScalar(0.5);
    const vertices = s
      .physics!.bodies!.find((b) => b.id === s.materialBodyId)
      ?.convexParts?.flat();
    const corners: Vector3[] =
      vertices?.map((v) => new Vector3(...v).applyQuaternion(relative)) ?? [];
    if (!vertices)
      for (const x of [-1, 1])
        for (const y of [-1, 1])
          for (const z of [-1, 1])
            corners.push(
              new Vector3(x * half.x, y * half.y, z * half.z).applyQuaternion(
                relative,
              ),
            );
    const contained = (axis: "x" | "z", size: number) =>
      local[axis] + Math.min(...corners.map((v) => v[axis])) >=
        -size / 2 - 0.005 &&
      local[axis] + Math.max(...corners.map((v) => v[axis])) <=
        size / 2 + 0.005;
    return (
      this.physics.hasSupport(s.materialBodyId, s.supportSurfaceId) &&
      contained("x", support.size[0]) &&
      contained("z", support.size[2]) &&
      new Vector3(...p.position).distanceTo(new Vector3(...s.placementCenter)) <
        0.12 &&
      Math.hypot(...p.velocity) < 0.08 &&
      Math.hypot(...(p.angularVelocity ?? [0, 0, 0])) < 0.2
    );
  }
  dispose() {
    this.physics.removeGrasp?.(this.constraintId);
    this.binding = undefined;
  }
}

/** 为机械臂任务规划关节轨迹，按物理步执行移动、抓放、等待和信号读写，并依据到位与支承反馈推进步骤。 */
interface PlannedStep {
  step: RobotStep;
  q?: number[];
  target?: Vector3;
  fk?: RobotKinematics;
}
export class RobotJobRunner {
  readonly fk: RobotKinematics;
  readonly grasp?: GraspService;
  private steps: PlannedStep[] = [];
  private index = 0;
  private elapsed = 0;
  private releaseStarted = false;
  private gripStarted = false;
  private trajectory?: JointTrajectory;
  private previousTCP: BodyPose;
  constructor(
    private scene: CompiledRobotScene,
    readonly state: RobotState,
    private signals: SignalRegistry,
    private physics?: PhysicsPort,
    placementCheck?: () => boolean,
  ) {
    this.fk = new RobotKinematics(scene);
    this.previousTCP = this.fk.forward(state.q).tcp;
    if (physics) this.grasp = new GraspService(scene, physics, placementCheck);
  }
  captureSelection?: string;
  plan(steps: RobotStep[]) {
    for (const step of steps)
      if (step.kind === "grip") {
        if (this.scene.materialGraspFrames)
          selectGraspFrame(this.scene.materialGraspFrames, step.grasp);
        else if (step.grasp !== undefined)
          throw new Error("物料未声明抓取接口: " + step.grasp);
      }
    let seed = [...this.state.q];
    let carrying = this.grasp?.relative;
    const visited = new Map<string, number[]>();
    const planned = steps.map((step, index) => {
      if (step.kind === "move_to_pose") {
        const target = this.fk.targetToWorld(step.position, step.frame);
        let fk = this.fk;
        if (step.subject === "held_material") {
          if (!carrying) throw new Error("物料中心目标需要已抓取的工件");
          const model = structuredClone(this.scene),
            t = model.model.tooling.tcp_local_frame;
          const m = new Matrix4()
            .compose(
              new Vector3(...t.position),
              new Quaternion(...t.rotation_quaternion),
              new Vector3(1, 1, 1),
            )
            .multiply(carrying);
          const p = new Vector3(),
            r = new Quaternion();
          m.decompose(p, r, new Vector3());
          t.position = p.toArray();
          t.rotation_quaternion = r.toArray();
          fk = new RobotKinematics(model);
        }
        const key =
            (step.subject ?? "tcp") +
            target.toArray().join(",") +
            JSON.stringify(step.world_rotation),
          cached = visited.get(key),
          solver = step.world_rotation
            ? new DampedPoseIK(fk, new Quaternion(...step.world_rotation))
            : new CcdPositionIK(fk);
        let solved = cached
          ? { q: cached, converged: true, error: 0, iterations: 0 }
          : solver.solve(target, seed);
        if (step.subject === "held_material" && step.support_clearance) {
          const support = this.scene.physics!.bodies!.find(
              (b) => b.role === "conveying_support",
            )!,
            size = this.scene.materialSize!;
          for (let n = 0; n < 12 && solved.converged; n++) {
            const rot = new Quaternion(...fk.forward(solved.q).tcp.rotation);
            const extent = [
              new Vector3(1, 0, 0),
              new Vector3(0, 1, 0),
              new Vector3(0, 0, 1),
            ].reduce(
              (sum, v, i) =>
                sum + (Math.abs(v.applyQuaternion(rot).y) * size[i]) / 2,
              0,
            );
            const minY =
              support.position[1] + support.size[1] / 2 + extent + 0.008;
            if (target.y >= minY - 0.001) break;
            target.y = minY;
            solved = solver.solve(target, solved.q);
          }
        }
        this.state.ik = solved;
        if (!solved.converged)
          throw new RobotPlanError(
            fk,
            target,
            solved,
            index + 1,
            step.label ?? "位置移动",
            step.subject ?? "tcp",
          );
        seed = [...solved.q];
        visited.set(key, seed);
        return { step, q: seed, target, fk };
      }
      if (step.kind === "move_joints") {
        step.q.forEach((q, i) => {
          const l = this.scene.model.urdf.joints[i].limit;
          if (l !== null && (q < l.lower || q > l.upper))
            throw new Error("关节目标超出限位");
        });
        seed = [...step.q];
        return { step, q: seed };
      }
      if (
        (step.kind === "grip" || step.kind === "release") &&
        (!this.grasp || step.materialId !== this.scene.materialInstanceId)
      )
        throw new Error("抓放物料或物理能力无效");
      if (step.kind === "grip") {
        const tcp = this.fk.forward(seed).tcp,
          p = this.physics!.readMaterial();
        carrying = new Matrix4()
          .compose(
            new Vector3(...tcp.position),
            new Quaternion(...tcp.rotation),
            new Vector3(1, 1, 1),
          )
          .invert()
          .multiply(
            new Matrix4().compose(
              new Vector3(...p.position),
              new Quaternion(...p.rotation),
              new Vector3(1, 1, 1),
            ),
          );
      } else if (step.kind === "release") carrying = undefined;
      return { step };
    });
    this.captureSelection = steps.find((step) => step.kind === "grip")?.grasp;
    this.steps = planned;
    this.index = 0;
    this.elapsed = 0;
    this.releaseStarted = false;
    this.gripStarted = false;
    this.trajectory = undefined;
    this.state.error = "";
    this.state.observations = {};
  }
  get finished() {
    return this.index >= this.steps.length;
  }
  private next() {
    const k = this.steps[this.index].step.kind;
    this.state.observations[
      `${k === "move_joints" ? "move_to_pose" : k}.succeeded`
    ] = true;
    this.index++;
    this.elapsed = 0;
    this.releaseStarted = false;
    this.gripStarted = false;
    this.trajectory = undefined;
  }
  before(dt: number) {
    const s = this.state,
      enabled = this.signals.read("enableTag") === true;
    if (!enabled || s.holding) {
      if (!s.holding) this.trajectory = undefined;
      s.holding = true;
      s.qdot = s.qdot.map((v, i) => {
        const next =
          Math.sign(v) *
          Math.max(0, Math.abs(v) - this.scene.acceleration[i] * dt);
        s.q[i] += ((v + next) * dt) / 2;
        return next;
      });
      s.phase = s.qdot.some((v) => Math.abs(v) > this.scene.settleSpeed)
        ? "decelerating"
        : "holding";
      if (
        enabled &&
        s.qdot.every((v) => Math.abs(v) <= this.scene.settleSpeed)
      ) {
        s.qdot.fill(0);
        s.holding = false;
      }
    } else if (!this.finished) {
      const p = this.steps[this.index];
      s.phase = `${this.index + 1}/${this.steps.length} ${p.step.kind}`;
      if (p.q) {
        this.trajectory ??= new JointTrajectory(
          [...s.q],
          p.q,
          this.scene.speed,
          this.scene.acceleration,
        );
        Object.assign(s, this.trajectory.step(dt));
      }
    }
    const tcp = this.fk.forward(s.q).tcp;
    tcp.velocity = new Vector3(...tcp.position)
      .sub(new Vector3(...this.previousTCP.position))
      .divideScalar(dt)
      .toArray();
    this.physics?.moveTool?.(this.scene.toolBodyId, tcp, dt);
    this.previousTCP = tcp;
  }
  after(dt: number, tick: number) {
    const s = this.state;
    if (
      this.grasp?.holding &&
      this.grasp.error(this.previousTCP) >
        this.scene.model.gripper.constraint_tolerance_m
    )
      throw new Error(
        `抓取约束误差超限 ${this.scene.instanceId} ${s.phase}: ${this.grasp!.error(this.previousTCP).toFixed(4)} m`,
      );
    if (this.finished || this.signals.read("enableTag") !== true || s.holding)
      return;
    const { step, q, target, fk } = this.steps[this.index];
    this.elapsed += dt;
    if (q) {
      s.errorM = target
        ? new Vector3(...(fk ?? this.fk).forward(s.q).tcp.position).distanceTo(
            target,
          )
        : Math.max(...s.q.map((v, i) => Math.abs(v - q[i])));
      if (
        this.trajectory?.done &&
        s.qdot.every((v) => Math.abs(v) <= this.scene.settleSpeed) &&
        s.errorM <= this.scene.tolerance
      )
        this.next();
    } else if (step.kind === "wait_time") {
      if (this.elapsed >= step.seconds) this.next();
    } else if (step.kind === "wait_signal") {
      if (this.signals.peek(step.portId) === step.value) this.next();
      else if (this.elapsed > step.timeout) throw new Error("等待信号超时");
    } else if (step.kind === "set_output") {
      this.signals.publish(step.portId, step.value, tick);
      this.next();
    } else if (step.kind === "grip") {
      if (!this.gripStarted) {
        this.grasp!.grip(this.previousTCP, step.materialId, step.grasp);
        this.gripStarted = true;
      } else if (this.grasp!.holding && this.elapsed >= 0.05) this.next();
    } else if (step.kind === "release") {
      if (!this.releaseStarted) {
        const p = this.physics!.readMaterial();
        if (
          new Vector3(...p.position).distanceTo(
            new Vector3(...this.scene.placementCenter!),
          ) > 0.12
        )
          throw new Error("物料未到达释放区域");
        this.grasp!.release(step.materialId);
        this.releaseStarted = true;
      } else if (this.grasp!.placed()) this.next();
      else if (this.elapsed > 5) throw new Error("目标支承交接超时");
    }
  }
  get tcp() {
    return this.previousTCP;
  }
  dispose() {
    this.grasp?.dispose();
  }
}

/** 根据已编译的机械臂配置、信号表和可选物理接口，为单设备仿真创建独立的机械臂状态和任务执行器。 */
export const RobotArmTemplate = {
  id: "robot.articulated",
  version: "1",
  create(
    scene: CompiledRobotScene,
    signals: SignalRegistry,
    physics?: PhysicsPort,
  ) {
    const state = new RobotState();
    return {
      state,
      runner: new RobotJobRunner(scene, state, signals, physics),
    };
  },
};

/** 运行单机械臂仿真，校验并提交动作命令，驱动作业执行器按步运行，并发布关节、抓持和请求反馈。 */
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
    this.script = RobotArmTemplate.create(scene, this.signals, physics);
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
  pickPlaceCommand(requestId: number, grasp?: string): RobotCommand {
    if (!this.physics) throw new Error("请选择物料和目标支承并准备物理实验");
    return {
      requestId,
      instanceId: this.scene.instanceId,
      behaviorId: "pick_and_place",
      steps: pickPlaceSteps(
        this.scene,
        this.physics.readMaterial(),
        "joint_ptp",
        grasp,
      ),
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
    const selected = this.ledger.request
      ? this.script.runner.captureSelection
      : undefined;
    const frames = this.scene.materialGraspFrames;
    const hasTarget =
      !frames ||
      selected ||
      frames.preferred ||
      Object.keys(frames.points).length === 1;
    const capture =
      material && this.scene.materialSize && hasTarget
        ? captureFrame(this.scene, material, selected).tcp
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
        targets:
          capture && this.scene.placementCenter
            ? {
                pickTCP: capture.toArray(),
                placeCenter: [...this.scene.placementCenter],
              }
            : undefined,
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

/** 将场景中的抓放和位姿请求交给机械臂任务执行器，在共享物理世界中推进动作，向调度器反馈关节状态、放置结果及故障。 */
export interface PreparedRobotAction {
  scene: CompiledRobotScene;
  steps: RobotStep[];
  returnToRest?: boolean;
}
/** Reuses the existing FK/IK/trajectory/grasp runner while the scene owns physics.step. */
export class RobotSceneAdapter implements DeviceActionPort {
  readonly id: string;
  private state = new RobotState();
  private runner?: RobotJobRunner;
  private request?: ActionRequest;
  private prepared?: {
    source: ActionRequest;
    frozen: ActionRequest;
    runner: RobotJobRunner;
    state: RobotState;
    action: PreparedRobotAction;
  };
  private action?: PreparedRobotAction;
  private placementConfirmed = false;
  private terminal = false;
  private readonly handshake: DeviceRequestLatch;
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
    private placementCheck?: (request: ActionRequest) => boolean,
  ) {
    this.id = base.instanceId;
    this.handshake = new DeviceRequestLatch(
      sceneId,
      runId,
      this.id,
      "start_pick",
    );
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
  sampleInputs(frame: Readonly<SceneSignalFrame>) {
    this.handshake.sample(frame);
  }
  prepare(source: ActionRequest, frame: Readonly<SceneSignalFrame>) {
    this.prepared = undefined;
    this.handshake.check(source, frame);
    const request = immutable(structuredClone(source));
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
      this.placementCheck ? () => this.placementCheck!(request) : undefined,
    );
    if (action.returnToRest) {
      const home = command.steps[0];
      if (
        command.behaviorId !== "move_to_pose" ||
        home.kind !== "move_to_pose" ||
        home.frame !== "world" ||
        !home.world_rotation
      )
        throw new Error("Invalid rest-pose binding");
      const q = restJointTarget(action.scene, {
        position: home.position,
        rotation: home.world_rotation,
      });
      runner.plan([{ kind: "move_joints", q }]);
    } else {
      runner.plan(command.steps);
    }
    this.prepared = { source, frozen: request, runner, state, action };
    return [
      this.write("enableTag", true, request),
      this.write("start_pick", true, request),
      this.write("request_id", Number(request.requestId), request),
    ];
  }
  submit(source: ActionRequest) {
    if (this.prepared?.source !== source)
      throw new Error("Robot action not prepared");
    const request = this.prepared.frozen;
    this.handshake.submit(request);
    this.runner?.dispose();
    this.runner = this.prepared.runner;
    this.state = this.prepared.state;
    this.action = this.prepared.action;
    this.placementConfirmed = false;
    this.prepared = undefined;
    this.request = request;
    this.terminal = false;
    this.stopping = false;
    this.error = "";
    this.localSignals.command("enableTag", true);
    this.feedback.push(this.handshake.accept()!);
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
    if (!this.handshake.matches(request))
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
  /** 读取关节、工具刚体和夹持状态，核实绑定的归位目标。 */
  isAtHome(
    home: Pick<
      SceneDevice["locations"][string],
      "position" | "reference" | "rotation_quaternion"
    >,
  ) {
    if (!this.isStopped() || !home) return false;
    const pose = this.physics.readBody!(this.base.toolBodyId);
    return (
      new Vector3(...pose.position).distanceTo(new Vector3(...home.position)) <=
        2 * this.base.tolerance &&
      (!home.rotation_quaternion ||
        new Quaternion(...pose.rotation).angleTo(
          new Quaternion(...home.rotation_quaternion),
        ) <= 0.05) &&
      (home.reference !== "robot_rest_pose" ||
        this.state.q.every((q) => Math.abs(q) <= this.base.tolerance))
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
          this.handshake.finish(false);
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
      if (this.runner.grasp?.holding) this.placementConfirmed = false;
      else if (
        this.action?.scene.materialBodyId &&
        this.physics.isBodyActive?.(this.action.scene.materialBodyId) !==
          false &&
        this.runner.grasp?.placed()
      )
        this.placementConfirmed = true;
      const targetStep = this.action?.steps[0],
        poseTarget =
          this.request.behavior === "move_to_pose" &&
          targetStep?.kind === "move_to_pose"
            ? this.runner.fk
                .targetToWorld(targetStep.position, targetStep.frame)
                .toArray()
            : undefined;
      if (
        !this.terminal &&
        !this.stopping &&
        this.runner.finished &&
        physicallyAtTCP &&
        this.isStopped()
      ) {
        this.feedback.push({ ...this.request, status: "succeeded" });
        this.terminal = true;
        this.handshake.finish(true);
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
          motionIntegrity:
            !this.error &&
            physicallyAtTCP &&
            (!this.runner.grasp?.holding ||
              this.runner.grasp.error(tcp) <=
                this.base.model.gripper.constraint_tolerance_m),
          placementConfirmed: this.placementConfirmed,
          targetError: poseTarget
            ? Math.hypot(...measured.position.map((v, i) => v - poseTarget[i]))
            : null,
          orientationSatisfied:
            targetStep?.kind === "move_to_pose" && targetStep.world_rotation
              ? new Quaternion(...measured.rotation).angleTo(
                  new Quaternion(...targetStep.world_rotation),
                ) <= 0.005
              : true,
        },
      });
    }
    const values = {
      busy: !!this.request && !this.terminal,
      error: !!this.error,
      error_code: this.error ? 1 : 0,
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
    this.signals.push(...this.handshake.publish());
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
  dispose(reason?: "discard") {
    if (reason !== "discard" && !this.isStopped())
      throw new Error("Robot still moving or holding material");
    this.runner?.dispose();
  }
}

/** 封装机械臂的逆运动学求解、关节轨迹步进和制动，并记录工具与持件的相对位姿，供双臂交接和工具加工使用。 */
export function poseMatrix(p: Pick<BodyPose, "position" | "rotation">) {
  return new Matrix4().compose(
    new Vector3(...p.position),
    new Quaternion(...p.rotation),
    new Vector3(1, 1, 1),
  );
}

export class HandoffArm {
  readonly fk: RobotKinematics;
  readonly graspId: string;
  q = [0, 0, 0, 0, 0, 0];
  qdot = [0, 0, 0, 0, 0, 0];
  private path: number[][] = [];
  private motion?: JointTrajectory;
  private braking = false;
  readonly axis: Vector3;
  readonly home: BodyPose;
  held?: string;
  heldFrame?: string;
  relative?: Matrix4;
  constructor(
    readonly scene: CompiledRobotScene,
    axis: Vec3,
    private physics: PhysicsPort,
  ) {
    this.axis = new Vector3(...axis);
    this.fk = new RobotKinematics(scene);
    this.home = this.fk.forward(this.q).tcp;
    this.graspId = scene.instanceId + "/handoff-grasp";
  }
  get stopped() {
    return (
      !this.path.length &&
      !this.motion &&
      this.qdot.every((v) => Math.abs(v) < 1e-7) &&
      Math.hypot(...this.physics.readBody!(this.scene.toolBodyId).velocity) <
        0.015
    );
  }
  get atHome() {
    return this.q.every((v) => Math.abs(v) < 1e-6) && this.stopped;
  }
  get holding() {
    return !!this.held && !!this.physics.hasGrasp!(this.graspId);
  }
  get pose() {
    return this.physics.readBody!(this.scene.toolBodyId);
  }
  rotationFacing(direction: Vector3, roll: number) {
    const home = new Quaternion(...this.home.rotation);
    return new Quaternion()
      .setFromAxisAngle(direction, roll)
      .multiply(
        new Quaternion()
          .setFromUnitVectors(
            this.axis.clone().applyQuaternion(home),
            direction,
          )
          .multiply(home),
      );
  }
  solve(position: Vector3, rotation: Quaternion, seed = this.q) {
    const solver = new DampedPoseIK(this.fk, rotation);
    const direct = solver.solve(position, seed);
    if (
      direct.converged &&
      Math.max(...direct.q.map((v, i) => Math.abs(v - seed[i]))) < 1.8
    )
      return direct.q;
    const candidates = [...(direct.converged ? [direct.q] : [])] as number[][];
    // Try alternate elbow and shoulder configurations inside the agreed joint limits.
    for (const shoulder of [-1.5, 0, 1.5])
      for (const elbow of [-1.5, 1.5]) {
        const result = solver.solve(position, [
          shoulder,
          -elbow / 2,
          elbow,
          -elbow / 2,
          0,
          0,
        ]);
        if (result.converged) candidates.push(result.q);
      }
    const distance = (q: number[]) =>
      q.reduce((sum, v, i) => sum + (v - seed[i]) ** 2, 0);
    return candidates.sort((a, b) => distance(a) - distance(b))[0];
  }
  target(
    position: Vector3,
    rotation: Quaternion,
    label: string,
    seed = this.q,
  ) {
    const result = this.solve(position, rotation, seed);
    if (!result)
      throw new Error(
        `${this.scene.instanceId} ${label} IK 未收敛 (${position
          .toArray()
          .map((v) => v.toFixed(3))
          .join(", ")})`,
      );
    return result;
  }
  start(path: number[][]) {
    this.path = [...path];
    this.motion = undefined;
    this.braking = false;
  }
  stop() {
    this.path = [];
    this.motion = undefined;
    this.braking = true;
  }
  step(dt: number) {
    if (this.braking) {
      this.q = this.q.map((v, i) => {
        const before = this.qdot[i];
        this.qdot[i] =
          Math.sign(before) *
          Math.max(0, Math.abs(before) - this.scene.acceleration[i] * dt);
        const limit = this.scene.model.urdf.joints[i].limit,
          next = v + ((before + this.qdot[i]) * dt) / 2;
        if (!limit) return next;
        if (next < limit.lower || next > limit.upper) this.qdot[i] = 0;
        return Math.max(limit.lower, Math.min(limit.upper, next));
      });
    } else if (this.path.length) {
      this.motion ??= new JointTrajectory(
        this.q,
        this.path[0],
        this.scene.speed,
        this.scene.acceleration,
      );
      const frame = this.motion.step(dt);
      this.q = frame.q;
      this.qdot = frame.qdot;
      if (this.motion.done) {
        this.path.shift();
        this.motion = undefined;
      }
    }
    this.physics.moveTool!(
      this.scene.toolBodyId,
      this.fk.forward(this.q).tcp,
      dt,
    );
  }
  attach(material: string, pose: BodyPose, frame?: string) {
    this.held = material;
    this.heldFrame = frame;
    this.relative = poseMatrix(this.pose).invert().multiply(poseMatrix(pose));
  }
  clear() {
    this.relative = undefined;
    this.held = undefined;
    this.heldFrame = undefined;
  }
}

/** 驱动机械臂接近工件加工口，对准并停稳后累计加工时间，归位时报告实际对接误差和持续步数。 */
export interface ProcessContact {
  position: Vector3;
  outward: Vector3;
}
export interface ProcessEvidence {
  startTick: number;
  endTick: number;
  dwellTicks: number;
  maxPositionError: number;
  maxAngleErrorDeg: number;
}

/** Approach the named material port, maintain physical TCP alignment for the cycle, then retreat. */
export class RobotProcessingMotion {
  phase = "idle";
  alignment: { positionError: number; angleErrorDeg: number } | null = null;
  constructor(
    readonly arm: HandoffArm,
    private duration: number,
    private positionTolerance: number,
    private angleTolerance: number,
  ) {}

  private path(contact: ProcessContact) {
    const toward = contact.outward.clone().negate();
    const approach = contact.position
      .clone()
      .addScaledVector(contact.outward, this.arm.scene.liftHeight);
    for (const roll of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const rotation: Quaternion = this.arm.rotationFacing(toward, roll);
      const near = this.arm.solve(approach, rotation);
      const touch = near && this.arm.solve(contact.position, rotation, near);
      if (near && touch) return { near, touch };
    }
    throw new Error(
      "Processing TCP cannot reach the declared workpiece interface with its required approach direction",
    );
  }
  private measure(contact: ProcessContact) {
    const pose = this.arm.pose;
    const direction = this.arm.axis
      .clone()
      .applyQuaternion(new Quaternion(...pose.rotation));
    return {
      positionError: new Vector3(...pose.position).distanceTo(contact.position),
      angleErrorDeg:
        (direction.angleTo(contact.outward.clone().negate()) * 180) / Math.PI,
    };
  }
  job(
    contact: () => ProcessContact,
    interlocked: () => boolean,
    complete: (tick: number, evidence: ProcessEvidence) => void,
  ): WarehouseJob {
    const path = this.path(contact());
    let elapsed = 0,
      done = false,
      cancelled = false,
      dt = 0;
    const evidence: ProcessEvidence = {
      startTick: 0,
      endTick: 0,
      dwellTicks: 0,
      maxPositionError: 0,
      maxAngleErrorDeg: 0,
    };
    return {
      begin: () => {
        this.phase = "approach";
        this.alignment = null;
        this.arm.start([path.near, path.touch]);
      },
      before: (step) => {
        dt = step;
        this.arm.step(step);
      },
      after: (tick) => {
        if (cancelled) return;
        if (!interlocked())
          throw new Error("Indexed workpiece moved during processing");
        if (!this.arm.stopped) {
          if (this.phase === "process")
            throw new Error("Processing TCP moved during the dwell interval");
          return;
        }
        if (this.phase === "approach" || this.phase === "process") {
          this.alignment = this.measure(contact());
          const { positionError, angleErrorDeg } = this.alignment;
          if (
            positionError > this.positionTolerance ||
            angleErrorDeg > this.angleTolerance
          )
            throw new Error(
              `Tool/workpiece processing port error: ${positionError.toFixed(4)} m, ${angleErrorDeg.toFixed(2)} degrees`,
            );
          this.phase = "process";
          if (evidence.dwellTicks === 0) evidence.startTick = tick;
          evidence.endTick = tick;
          evidence.dwellTicks++;
          evidence.maxPositionError = Math.max(
            evidence.maxPositionError,
            positionError,
          );
          evidence.maxAngleErrorDeg = Math.max(
            evidence.maxAngleErrorDeg,
            angleErrorDeg,
          );
          elapsed += dt;
          if (elapsed + 1e-9 >= this.duration) {
            this.phase = "retreat";
            this.arm.start([path.near, this.arm.q.map(() => 0)]);
          }
        } else if (this.phase === "retreat" && this.arm.atHome) {
          this.phase = "idle";
          done = true;
          complete(tick, evidence);
        }
      },
      cancel: () => {
        cancelled = true;
        this.phase = "stopped";
        this.arm.stop();
      },
      stopped: () => this.arm.stopped,
      complete: () => done,
    };
  }
}

export function homeAction(
  base: CompiledRobotScene,
  home: SceneDevice["locations"][string] | undefined,
): PreparedRobotAction {
  if (!home || home.frame !== "flange_pose_scene_world_m")
    throw new Error("Unknown robot retreat target");
  if (home.reference === "robot_rest_pose" && !home.rotation_quaternion)
    throw new Error("GLB 回位目标缺少法兰朝向");
  return {
    scene: base,
    returnToRest: home.reference === "robot_rest_pose",
    steps: [
      {
        kind: "move_to_pose",
        position: home.position,
        frame: "world",
        world_rotation: home.rotation_quaternion,
      },
    ],
  };
}

export function topPickAndPlace(
  base: CompiledRobotScene,
  material: string,
  load: RuntimeBody,
  pose: BodyPose,
  center: Vec3,
  rotation: Quat,
  grasp?: { frames: MaterialGraspFrames; name?: string },
): PreparedRobotAction {
  const at = new Vector3(...pose.position),
    to = new Vector3(...center).add(new Vector3(0, 0.008, 0));
  const materialRotation = new Quaternion(...pose.rotation);
  const selected = grasp
    ? worldGraspFrame(grasp.frames, grasp.name, pose, 0.025)
    : undefined;
  const topNormal =
    selected?.outward ?? new Vector3(0, 1, 0).applyQuaternion(materialRotation);
  const capture =
    selected?.tcp ??
    at.clone().addScaledVector(topNormal, load.size[1] / 2 + 0.025);
  const captureOffset = capture.clone().sub(at);
  // On the GLB wrist the last roll axis passes through the flange. Choose its
  // outward end from the penultimate wrist pivot, then point it at the top face.
  const rest = new RobotKinematics(base).forward(
    base.model.urdf.joints.map(() => 0),
  );
  const declaredAxis = base.model.tooling.approach_axis_local;
  let approach: Vector3;
  if (declaredAxis) {
    approach = new Vector3(...declaredAxis).applyQuaternion(
      new Quaternion(...rest.tcp.rotation),
    );
  } else {
    approach = rest.joints.at(-1)!.axis.clone();
    const wristToFlange = new Vector3(...rest.tcp.position).sub(
      rest.joints.at(-2)!.pivot,
    );
    const extension = approach.dot(wristToFlange);
    if (Math.abs(extension) < 1e-6)
      throw new Error(
        "Cannot resolve the tool approach direction from the GLB wrist",
      );
    approach.multiplyScalar(Math.sign(extension));
  }
  const graspRotation = new Quaternion()
    .setFromUnitVectors(approach, topNormal.clone().negate())
    .multiply(new Quaternion(...rest.tcp.rotation));
  // Preserve the tool/material relationship when retracting after a rotated placement.
  const materialTurn = new Quaternion(...rotation).multiply(
    materialRotation.clone().invert(),
  );
  const releaseRotation = materialTurn.clone().multiply(graspRotation);
  const safeY = Math.max(at.y, to.y) + base.liftHeight;
  const raised = new Vector3(at.x, safeY, at.z),
    above = new Vector3(to.x, safeY, to.z);
  const move = (pt: Vector3, orientation: Quaternion): RobotStep => ({
    kind: "move_to_pose",
    position: pt.toArray(),
    frame: "world",
    world_rotation: orientation.toArray(),
  });
  const held = (
    start: Vector3,
    end: Vector3,
    q0: Quat,
    q1: Quat,
  ): RobotStep[] =>
    Array.from({ length: 8 }, (_, i) => {
      const t = (i + 1) / 8;
      return {
        kind: "move_to_pose",
        subject: "held_material",
        position: start.clone().lerp(end, t).toArray(),
        frame: "world",
        world_rotation: new Quaternion(...q0)
          .slerp(new Quaternion(...q1), t)
          .toArray(),
      };
    });
  const steps: RobotStep[] = [
    move(
      capture.clone().addScaledVector(topNormal, base.liftHeight),
      graspRotation,
    ),
    move(capture, graspRotation),
    {
      kind: "grip",
      materialId: material,
      ...(grasp?.name ? { grasp: grasp.name } : {}),
    },
    ...held(at, raised, pose.rotation, pose.rotation),
    ...held(raised, above, pose.rotation, rotation),
    ...held(above, to, rotation, rotation),
    { kind: "release", materialId: material },
    move(
      above.clone().add(captureOffset.applyQuaternion(materialTurn)),
      releaseRotation,
    ),
  ];
  return {
    scene: {
      ...base,
      materialInstanceId: material,
      subjectId: material,
      materialBodyId: load.id,
      materialSize: load.size,
      materialGraspFrames: grasp?.frames,
      materialMass: load.mass,
      placementCenter: center,
      placementRotation: rotation,
    },
    steps,
  };
}

/** Generate the transport path to an output belt; the scene supplies the measured endpoints. */
export function pickAndPlaceOnBelt(
  scene: CompiledRobotScene,
  material: string,
  pose: BodyPose,
  place: Vector3,
  grasp?: string,
): PreparedRobotAction {
  const capture = captureFrame(scene, pose, grasp);
  const axis = scene.model.tooling.approach_axis_local;
  const orientation =
    scene.materialGraspFrames && axis
      ? new Quaternion()
          .setFromUnitVectors(
            new Vector3(...axis),
            capture.outward.clone().negate(),
          )
          .toArray()
      : undefined;
  // The legacy top-surface approach retracts vertically in the cell frame.
  // A declared material port instead supplies its own approach normal.
  const approach = scene.materialGraspFrames ? capture.outward : new Vector3(0, 1, 0);
  const safeY = Math.max(pose.position[1], place.y) + scene.liftHeight;
  const move = (
    position: Vector3,
    held = false,
    clearance = false,
  ): RobotStep => ({
    kind: "move_to_pose",
    position: position.toArray(),
    frame: "world",
    subject: held ? "held_material" : "tcp",
    support_clearance: clearance,
    ...(held ? { world_rotation: pose.rotation } : {}),
  });
  const lift = Array.from({ length: 10 }, (_, i) =>
    move(
      new Vector3(...pose.position).add(
        new Vector3(0, ((safeY - pose.position[1]) * (i + 1)) / 10, 0),
      ),
      true,
    ),
  );
  const descend = Array.from({ length: 10 }, (_, i) =>
    move(
      place.clone().add(new Vector3(0, ((safeY - place.y) * (9 - i)) / 10, 0)),
      true,
      i === 9,
    ),
  );
  const raised = new Vector3(pose.position[0], safeY, pose.position[2]),
    clear = new Vector3(pose.position[0], safeY, place.z),
    above = new Vector3(place.x, safeY, place.z);
  const segment = (a: Vector3, b: Vector3) =>
    Array.from({ length: 10 }, (_, i) =>
      move(a.clone().lerp(b, (i + 1) / 10), true),
    );
  return {
    scene,
    steps: [
      {
        ...move(
          capture.tcp
            .clone()
            .addScaledVector(approach, scene.liftHeight),
        ),
        ...(orientation ? { world_rotation: orientation } : {}),
      },
      {
        ...move(capture.tcp),
        ...(orientation ? { world_rotation: orientation } : {}),
      },
      { kind: "grip", materialId: material, ...(grasp ? { grasp } : {}) },
      ...lift,
      ...segment(raised, clear),
      ...segment(clear, above),
      ...descend,
      { kind: "release", materialId: material },
      move(above),
    ],
  };
}

/** 单臂取放的标准步骤序列，用同一工件刚体的实际位姿和本次目标支承规划。 */
export function pickPlaceSteps(
  s: CompiledRobotScene,
  p: BodyPose,
  carryMode: "joint_ptp" | "preserve_orientation" = "preserve_orientation",
  grasp?: string,
): RobotStep[] {
  if (!s.materialInstanceId || !s.placementCenter || !s.materialSize)
    throw new Error("请选择物料和目标支承并准备物理实验");
  const capture = captureFrame(s, p, grasp),
    pick = capture.tcp;
  const axis = s.model.tooling.approach_axis_local;
  const orientation =
    s.materialGraspFrames && axis
      ? new Quaternion()
          .setFromUnitVectors(
            new Vector3(...axis),
            capture.outward.clone().negate(),
          )
          .toArray()
      : undefined;
  const move = (
    v: Vector3,
    label: string,
    worldRotation?: Quat,
  ): RobotStep => ({
    kind: "move_to_pose",
    position: v.toArray(),
    frame: "world",
    label,
    ...(worldRotation ? { world_rotation: worldRotation } : {}),
  });
  const center = new Vector3(...p.position),
    place = new Vector3(...s.placementCenter);
  const height = Math.max(center.y, place.y) + s.liftHeight;
  const preserve = carryMode === "preserve_orientation";
  const raised = new Vector3(
    center.x,
    preserve ? height : center.y + s.liftHeight,
    center.z,
  );
  const above = new Vector3(
    place.x,
    preserve ? height : place.y + s.liftHeight,
    place.z,
  );
  // Gravity and the fixed grasp both act on the actual box. Follow its center
  // through short segments while keeping its measured attitude so a long joint
  // interpolation cannot roll the supported lower corners back into the belt.
  const carry = (
    from: Vector3,
    to: Vector3,
    label: string,
    landing = false,
  ): RobotStep[] => {
    const count = preserve
      ? Math.max(1, Math.ceil(from.distanceTo(to) / 0.08))
      : 1;
    if (count > 64) throw new Error("持件轨迹超出单次机械臂任务的步骤上限");
    return Array.from({ length: count }, (_, i) => ({
      kind: "move_to_pose",
      frame: "world",
      subject: "held_material",
      position: from
        .clone()
        .lerp(to, (i + 1) / count)
        .toArray(),
      ...(preserve ? { world_rotation: p.rotation } : {}),
      support_clearance: landing && i === count - 1,
      label,
    }));
  };
  return [
    move(
      pick.clone().addScaledVector(capture.outward, s.liftHeight),
      "取料接近",
      orientation,
    ),
    move(pick, "下降取料", orientation),
    {
      kind: "grip",
      materialId: s.materialInstanceId,
      ...(grasp ? { grasp } : {}),
    },
    ...carry(center, raised, "抓取后抬升"),
    ...carry(raised, above, "转运至放料上方"),
    ...carry(above, place, "下降放料", true),
    { kind: "release", materialId: s.materialInstanceId },
    move(pick.clone().add(new Vector3(0, s.liftHeight * 2, 0)), "释放后退回"),
  ];
}

type PickStart =
  | { kind: "pick"; frame: string; sourceReady(): boolean }
  | { kind: "held"; frame: string };

type PlaceTarget =
  | {
      kind: "support";
      pose: BodyPose;
      placed(): boolean;
      commit(tick: number): void;
    }
  | {
      kind: "gripper";
      pose: BodyPose;
      receiver: HandoffArm;
      frame: string;
      commit(tick: number): void;
    };

interface MotionStage {
  enter(): void;
  ready(): boolean;
  leave?(tick: number): void;
}

const settled = (p: BodyPose) =>
  Math.hypot(...p.velocity) < 0.02 &&
  Math.hypot(...(p.angularVelocity ?? [])) < 0.12;

/** 抓放由显式起点和接收端组合。持件续行核对实际约束与接口，放置和交接复用同一条阶段执行路径。 */
export class PickPlaceMotion {
  constructor(
    private readonly physics: PhysicsPort,
    private readonly body: (material: string) => RuntimeBody,
    private readonly point: (
      material: string,
      frame: string,
      pose: BodyPose,
    ) => { tcp: Vector3; outward: Vector3 },
  ) {}

  private materialPose(id: string) {
    return this.physics.readBody!(this.body(id).id);
  }

  home(arm: HandoffArm, location: SceneDevice["locations"][string]) {
    const home = restJointTarget(arm.scene, {
      position: location.position,
      rotation: location.rotation_quaternion!,
    });
    return this.job(
      [arm],
      [{ enter: () => arm.start([home]), ready: () => arm.atHome }],
    );
  }

  private graspPlan(
    arm: HandoffArm,
    id: string,
    frame: string,
    pose: BodyPose,
    approach: number,
  ) {
    const p = this.point(id, frame, pose),
      near = p.tcp.clone().addScaledVector(p.outward, approach);
    for (const roll of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const rotation = arm.rotationFacing(p.outward.clone().negate(), roll);
      const before = arm.solve(near, rotation);
      const at = before && arm.solve(p.tcp, rotation, before);
      if (before && at) return [before, at];
    }
    throw new Error(
      arm.scene.instanceId + " 未找到与 " + frame + " 对齐的抓取姿态",
    );
  }
  private aligned(arm: HandoffArm, id: string, frame: string) {
    const pose = this.materialPose(id),
      tool = arm.pose,
      point = this.point(id, frame, pose);
    return (
      point.tcp.distanceTo(new Vector3(...tool.position)) <= 0.01 &&
      arm.axis
        .clone()
        .applyQuaternion(new Quaternion(...tool.rotation))
        .dot(point.outward) < -0.985 &&
      new Vector3(...pose.velocity)
        .sub(new Vector3(...tool.velocity))
        .length() <= arm.scene.model.gripper.max_relative_speed_mps
    );
  }
  private carriedPath(
    arm: HandoffArm,
    id: string,
    targets: BodyPose[],
    label: string,
  ) {
    let seed = arm.q;
    const inverse = arm.relative!.clone().invert(),
      segments: number[][] = [];
    let from = this.materialPose(id);
    for (const target of targets) {
      const a = new Vector3(...from.position),
        b = new Vector3(...target.position);
      const start = new Quaternion(...from.rotation),
        end = new Quaternion(...target.rotation);
      const count = Math.max(
        1,
        Math.ceil(a.distanceTo(b) / 0.075),
        Math.ceil(start.angleTo(end) / 0.3),
      );
      for (let i = 1; i <= count; i++) {
        const pose = poseMatrix({
          position: a
            .clone()
            .lerp(b, i / count)
            .toArray(),
          rotation: start
            .clone()
            .slerp(end, i / count)
            .toArray(),
        });
        const tcp = pose.multiply(inverse),
          position = new Vector3(),
          rotation = new Quaternion();
        tcp.decompose(position, rotation, new Vector3());
        seed = arm.target(position, rotation, label, seed);
        segments.push(seed);
      }
      from = target;
    }
    return segments;
  }
  private raised(p: BodyPose, h: number): BodyPose {
    return {
      ...p,
      position: [p.position[0], p.position[1] + h, p.position[2]],
    };
  }
  private retained(arm: HandoffArm, id: string) {
    if (arm.held !== id || !arm.holding)
      throw new Error("在途物料丢失持有关系");
    const expected = poseMatrix(arm.pose).multiply(arm.relative!),
      actual = this.materialPose(id);
    const distance = new Vector3()
      .setFromMatrixPosition(expected)
      .distanceTo(new Vector3(...actual.position));
    const angle = new Quaternion()
      .setFromRotationMatrix(expected)
      .angleTo(new Quaternion(...actual.rotation));
    if (
      Math.max(distance, angle * 0.1) >
      arm.scene.model.gripper.constraint_tolerance_m
    )
      throw new Error("工件偏离夹具约束");
  }

  prepare(
    arm: HandoffArm,
    material: string,
    start: PickStart,
    target: PlaceTarget,
  ): WarehouseJob {
    const load = this.body(material);
    if (
      !this.physics.isBodyActive!(load.id) ||
      load.mass! > arm.scene.maxPayload
    )
      throw new Error("抓取身份或载荷不合法");

    const stages: MotionStage[] = [];
    if (start.kind === "held") {
      if (
        !arm.holding ||
        arm.held !== material ||
        arm.heldFrame !== start.frame
      )
        throw new Error("持件起点与当前夹具、工件或抓取接口不匹配");
    } else {
      if (arm.held || arm.holding || !start.sourceReady())
        throw new Error("源物料或夹具未就绪");
      const pick = this.graspPlan(
        arm,
        material,
        start.frame,
        this.materialPose(material),
        0.09,
      );
      stages.push({
        enter: () => arm.start(pick),
        ready: () => arm.stopped,
        leave: () => {
          if (!start.sourceReady() || !this.aligned(arm, material, start.frame))
            throw new Error("抓取接口未对准");
          this.physics.createGrasp!(arm.graspId, arm.scene.toolBodyId, load.id);
          arm.attach(material, this.materialPose(material), start.frame);
        },
      });
    }
    if (target.kind === "support") {
      stages.push(...this.placeOnSupport(arm, material, target));
      return this.job([arm], stages);
    }
    if (
      target.receiver === arm ||
      target.receiver.held ||
      target.receiver.holding ||
      load.mass! > target.receiver.scene.maxPayload
    )
      throw new Error("接收夹具不可用或工件超出载荷");
    stages.push(...this.deliverToGripper(arm, material, start.frame, target));
    return this.job([arm, target.receiver], stages);
  }

  private deliverToGripper(
    arm: HandoffArm,
    material: string,
    sourceFrame: string,
    target: Extract<PlaceTarget, { kind: "gripper" }>,
  ): MotionStage[] {
    const receiver = target.receiver;
    return [
      {
        enter: () =>
          arm.start(
            this.carriedPath(
              arm,
              material,
              [this.raised(this.materialPose(material), 0.22), target.pose],
              "搬运到交接位",
            ),
          ),
        ready: () => arm.stopped && settled(this.materialPose(material)),
      },
      {
        enter: () =>
          receiver.start(
            this.graspPlan(
              receiver,
              material,
              target.frame,
              this.materialPose(material),
              0.09,
            ),
          ),
        ready: () => receiver.stopped,
        leave: () => {
          this.retained(arm, material);
          const pose = this.materialPose(material);
          if (
            receiver.held ||
            receiver.holding ||
            !settled(pose) ||
            !this.aligned(receiver, material, target.frame)
          )
            throw new Error("接收夹具未就绪或未对准");
          if (
            new Vector3(...pose.position).distanceTo(
              new Vector3(...target.pose.position),
            ) > 0.018 ||
            new Quaternion(...pose.rotation).angleTo(
              new Quaternion(...target.pose.rotation),
            ) > 0.08
          )
            throw new Error("工件未到达交接位姿");
          this.physics.transferGrasp!(
            arm.graspId,
            receiver.graspId,
            receiver.scene.toolBodyId,
            this.body(material).id,
          );
          receiver.attach(material, pose, target.frame);
          arm.clear();
        },
      },
      {
        enter: () => {
          const pose = arm.pose;
          const away = this.point(
            material,
            sourceFrame,
            this.materialPose(material),
          ).outward.multiplyScalar(0.09);
          arm.start([
            arm.target(
              new Vector3(...pose.position).add(away),
              new Quaternion(...pose.rotation),
              "离开交接位",
            ),
          ]);
        },
        ready: () => arm.stopped,
        leave: target.commit,
      },
    ];
  }

  private placeOnSupport(
    arm: HandoffArm,
    material: string,
    target: Extract<PlaceTarget, { kind: "support" }>,
  ): MotionStage[] {
    const release = this.raised(target.pose, 0.001);
    const path = () =>
      this.carriedPath(
        arm,
        material,
        [
          this.raised(this.materialPose(material), 0.12),
          this.raised(target.pose, 0.17),
          release,
        ],
        "移动到放置目标",
      );
    const preparedPath = arm.holding ? path() : undefined;
    let stable = 0;
    return [
      {
        enter: () => arm.start(preparedPath ?? path()),
        ready: () => arm.stopped && settled(this.materialPose(material)),
        leave: () => {
          const pose = this.materialPose(material);
          if (
            new Vector3(...pose.position).distanceTo(
              new Vector3(...release.position),
            ) > 0.01 ||
            new Quaternion(...pose.rotation).angleTo(
              new Quaternion(...release.rotation),
            ) >
              Math.PI / 90
          )
            throw new Error("工件未达到释放位姿");
          this.physics.removeGrasp!(arm.graspId);
          arm.clear();
        },
      },
      {
        enter: () => {},
        ready: () => {
          stable = target.placed() ? stable + 1 : 0;
          return stable >= 8;
        },
        leave: target.commit,
      },
      {
        enter: () => {
          const pose = arm.pose;
          arm.start([
            arm.target(
              new Vector3(...pose.position).add(new Vector3(0, 0.09, 0)),
              new Quaternion(...pose.rotation),
              "释放后抬升",
            ),
          ]);
        },
        ready: () => arm.stopped,
      },
    ];
  }
  private job(arms: HandoffArm[], stages: MotionStage[]): WarehouseJob {
    let index = 0,
      elapsed = 0;
    return {
      begin: () => stages[0].enter(),
      before: () => {},
      after: (tick) => {
        for (const arm of arms) if (arm.held) this.retained(arm, arm.held);
        const stage = stages[index];
        if (++elapsed > 1800) throw new Error("机械臂或工件支承未在时限内稳定");
        if (stage.ready()) {
          stage.leave?.(tick);
          elapsed = 0;
          stages[++index]?.enter();
        }
      },
      cancel: () => arms.forEach((a) => a.stop()),
      complete: () => index === stages.length,
      stopped: () => arms.every((a) => a.stopped),
    };
  }
}

export function createJobDriver(
  id: string,
  sceneId: string,
  runId: string,
  behaviors: readonly string[],
  plan: (r: ActionRequest) => WarehouseJob,
  stopped: () => boolean,
  holding: () => boolean,
  trigger: string,
  onSucceeded?: (request: ActionRequest) => void,
) {
  return new WarehouseActionAdapter(
    id,
    sceneId,
    runId,
    behaviors,
    plan,
    stopped,
    (fault) => ({ holding_material: holding(), error_code: fault ? 1 : 0 }),
    trigger,
    onSucceeded,
  );
}

export function createProcessingDriver(
  sceneId: string,
  runId: string,
  id: string,
  plan: (r: ActionRequest) => WarehouseJob,
  stopped: () => boolean,
) {
  return createJobDriver(
    id,
    sceneId,
    runId,
    ["process_material"],
    plan,
    stopped,
    () => false,
    "start_process",
  );
}

interface PickPlaceReading {
  held: boolean;
  stationary: boolean;
  targetSupported: boolean;
}

/** 抓取取决于接入的同件、同端点证据；夹具、资源与实际放置仍由本机独立核验。 */
export function bindPickPlaceConditions<W extends PickPlaceReading>(
  port: DeviceConditionBindings<W>,
  arm: RobotSceneAdapter,
  config: {
    robot: string;
    material: string;
    source: string;
    destination: string;
    sourceEvidence(world: W, context: ConditionContext): Truth;
  },
) {
  port.register(
    "kinematics_ready",
    (w, ctx) =>
      config.sourceEvidence(w, ctx) &&
      !w.held &&
      w.stationary &&
      arm.isStopped(),
  );
  port.register(
    "device_idle",
    (_, ctx) =>
      port.signal("busy", ctx) === false && port.signal("error", ctx) === false,
  );
  port.register(
    "tool_empty",
    (w, ctx) => !w.held && port.signal("holding_material", ctx) === false,
  );
  port.register(
    "source_authorized",
    (w, ctx) =>
      config.sourceEvidence(w, ctx) &&
      ctx.owns("material/" + config.material) &&
      ctx.owns("location/" + config.source),
  );
  port.register("target_reserved", (_, ctx) =>
    ctx.owns("location/" + config.destination),
  );
  port.register("pick_and_place.succeeded", (w, ctx) => {
    const receipt = ctx.observations?.samples[config.robot + "/robot_state"];
    return !!(
      w.targetSupported &&
      !w.held &&
      ctx.requestState?.outcome === "succeeded" &&
      ctx.request &&
      receipt?.quality === "good" &&
      receipt.runId === ctx.frame.runId &&
      receipt.requestId === ctx.request.requestId &&
      receipt.activationId === ctx.request.activationId &&
      receipt.subjectId === config.material &&
      (receipt.value as { placementConfirmed: boolean }).placementConfirmed
    );
  });
  port.register("stopped", () => arm.isStopped());
}

/** 按命令中的物料、接口和接收端建立抓放任务；接放许可由实时支承与持有关系提供。 */
export class RobotTransferActions {
  readonly placed = new Set<string>();
  readonly transfers: {
    material: string;
    from: string;
    to: string;
    tick: number;
  }[] = [];
  private motion: PickPlaceMotion;
  private owners: Map<string, SceneDevice>;
  constructor(
    readonly arms: Map<string, HandoffArm>,
    devices: ReadonlyMap<string, SceneDevice>,
    private observed: MaterialPoseObserver,
    physics: PhysicsPort,
  ) {
    this.owners = new Map(
      [...devices.values()].flatMap((d) =>
        Object.keys(d.locations).map((key) => [key, d] as const),
      ),
    );
    this.motion = new PickPlaceMotion(
      physics,
      (id) => observed.body(id),
      (id, frame, pose) =>
        worldGraspFrame(observed.frames.get(id)!, frame, pose, 0.017),
    );
  }
  arm(id: string) {
    const a = this.arms.get(id);
    if (!a) throw new Error("Unknown robot: " + id);
    return a;
  }
  prepare(r: ActionRequest) {
    const arm = this.arm(r.device);
    const p = r.payload as { binding: string; fields: Record<string, string> };
    const f = p.fields,
      mode = handoffBehavior(r.device, r.behavior, p.binding);
    const target = this.owners.get(f.target);
    if (!target) throw new Error("Unknown target: " + f.target);
    if (mode === "move_to_pose") {
      if (target.instance_id !== r.device)
        throw new Error("Foreign retreat target");
      return this.motion.home(arm, target.locations[f.target]);
    }
    if (mode === "pick_and_handoff") {
      const source = this.owners.get(f.source),
        receiver = this.arm(f.receiver);
      if (!source || f.giver_grasp === f.receiver_grasp)
        throw new Error("Invalid handoff interfaces");
      return this.motion.prepare(
        arm,
        f.material,
        {
          kind: "pick",
          frame: f.giver_grasp,
          sourceReady: () =>
            this.observed.checkPose(f.material, source.instance_id, f.source),
        },
        {
          kind: "gripper",
          receiver,
          frame: f.receiver_grasp,
          pose: this.observed.targetPose(
            f.material,
            target.instance_id,
            f.target,
            [f.giver_grasp, f.receiver_grasp],
          ),
          commit: (tick) =>
            this.transfers.push({
              material: f.material,
              from: r.device,
              to: receiver.scene.instanceId,
              tick,
            }),
        },
      );
    }
    if (mode !== "place_held_material")
      throw new Error("Unknown transfer action: " + mode);
    return this.motion.prepare(
      arm,
      f.material,
      { kind: "held", frame: f.grasp },
      {
        kind: "support",
        pose: this.observed.targetPose(
          f.material,
          target.instance_id,
          f.target,
        ),
        placed: () =>
          this.observed.checkPose(f.material, target.instance_id, f.target),
        commit: () => this.placed.add(f.material),
      },
    );
  }
}

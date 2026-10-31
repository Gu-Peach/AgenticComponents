import { Matrix4, Quaternion, Vector3 } from "three";
import type { CompiledRobotScene } from "@/contracts/robot";
import type { RobotStep } from "@/contracts/robot-command";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import { RobotKinematics } from "@/runtime/kinematics/RobotKinematics";
import { CcdPositionIK } from "@/runtime/kinematics/CcdPositionIK";
import { JointTrajectory } from "@/runtime/mechanisms/JointTrajectory";
import { GraspService } from "@/runtime/services/GraspService";
import { SignalRegistry } from "@/runtime/engine/SignalRegistry";
import { RobotState } from "./RobotState";
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
  ) {
    this.fk = new RobotKinematics(scene);
    this.previousTCP = this.fk.forward(state.q).tcp;
    if (physics) this.grasp = new GraspService(scene, physics);
  }
  plan(steps: RobotStep[]) {
    let seed = [...this.state.q];
    let carrying = this.grasp?.relative;
    const visited = new Map<string, number[]>();
    const planned = steps.map((step) => {
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
        const key = (step.subject ?? "tcp") + target.toArray().join(","),
          cached = visited.get(key),
          solver = new CcdPositionIK(fk);
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
          throw new Error(`IK未收敛，误差${solved.error.toFixed(4)}m`);
        seed = [...solved.q];
        visited.set(key, seed);
        return { step, q: seed, target, fk };
      }
      if (step.kind === "move_joints") {
        step.q.forEach((q, i) => {
          const l = this.scene.model.urdf.joints[i].limit;
          if (q < l.lower || q > l.upper) throw new Error("关节目标超出限位");
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
      throw new Error("抓取约束误差超限");
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
        this.grasp!.grip(this.previousTCP, step.materialId);
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

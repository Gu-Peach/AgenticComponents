import { Quaternion, Vector3 } from "three";
import type { IKResult } from "./PositionIK";
import { RobotKinematics } from "./RobotKinematics";
export interface RobotPlanDiagnostic {
  step: number;
  label: string;
  subject: "tcp" | "held_material";
  targetWorld: [number, number, number];
  targetBase: [number, number, number];
  error: number;
  tolerance: number;
  iterations: number;
  outsideReachBound: boolean;
}
export class RobotPlanError extends Error {
  readonly diagnostic: RobotPlanDiagnostic;
  constructor(
    fk: RobotKinematics,
    target: Vector3,
    result: IKResult,
    step: number,
    label: string,
    subject: "tcp" | "held_material",
  ) {
    const scene = fk.scene,
      base = target
        .clone()
        .sub(new Vector3(...scene.base.position))
        .applyQuaternion(new Quaternion(...scene.base.rotation).invert());
    const anchor = fk.forward([0, 0, 0, 0, 0, 0]).joints[0].pivot;
    // Triangle inequality is only an outer reach bound; being inside does not prove reachability.
    const radius =
      scene.model.urdf.joints
        .slice(1)
        .reduce((sum, j) => sum + Math.hypot(...j.rest_position), 0) +
      Math.hypot(...scene.model.tooling.rest_position) +
      Math.hypot(...scene.model.tooling.tcp_local_frame.position);
    const outside = anchor.distanceTo(target) > radius + scene.tolerance;
    const coords = (v: Vector3) =>
      `[${v
        .toArray()
        .map((n) => n.toFixed(3))
        .join(", ")}]`;
    const hint =
      subject === "held_material"
        ? "当前放料目标取所选传送带中心；请重置实验后，将目标传送带移近机械臂，再重新准备。"
        : "请重置实验后调整物料或目标位置，再重新准备。";
    super(
      `抓放预检查失败：第${step}步「${label}」的${subject === "held_material" ? "物料中心" : "TCP"}目标${outside ? "超出保守最大伸展范围" : "IK未收敛（不能据此断定不可达）"}。世界坐标${coords(target)} m；相对机械臂基座${coords(base)} m；求解残差${result.error.toFixed(4)} m，容差${scene.tolerance.toFixed(4)} m。${hint}本次任务未启动，未新增抓取约束。`,
    );
    this.name = "RobotPlanError";
    this.diagnostic = {
      step,
      label,
      subject,
      targetWorld: target.toArray(),
      targetBase: base.toArray(),
      error: result.error,
      tolerance: scene.tolerance,
      iterations: result.iterations,
      outsideReachBound: outside,
    };
  }
}

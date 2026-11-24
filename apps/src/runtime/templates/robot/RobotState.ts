/** 保存机械臂任务执行中的关节角、角速度、当前阶段、逆运动学结果和误差，供执行器更新和读取。 */

import type { IKResult } from "@/runtime/kinematics/PositionIK";
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

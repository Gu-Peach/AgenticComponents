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

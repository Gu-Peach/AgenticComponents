/** 定义位置逆运动学求解接口及结果，约定如何传入目标与初始关节角，以及如何报告解、误差和收敛状态。 */

import type { Vector3 } from "three";
export interface IKResult {
  q: number[];
  converged: boolean;
  error: number;
  iterations: number;
  orientationError?: number;
}
export interface PositionIK {
  solve(target: Vector3, seed: readonly number[]): IKResult;
}

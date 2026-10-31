import type { Vector3 } from "three";
export interface IKResult {
  q: number[];
  converged: boolean;
  error: number;
  iterations: number;
}
export interface PositionIK {
  solve(target: Vector3, seed: readonly number[]): IKResult;
}

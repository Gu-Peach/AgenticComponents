import type { Vec3 } from "./device";
export type Quat = [number, number, number, number];
export interface BodyPose {
  position: Vec3;
  rotation: Quat;
  velocity: Vec3;
}
export interface PhysicsConfig {
  surfacePosition: Vec3;
  rotation: Quat;
  surfaceSize: Vec3;
  materialPosition: Vec3;
  materialSize: Vec3;
  mass: number;
  friction: number;
  obstacle?: boolean;
}
export interface PhysicsPort {
  setSurfaceSpeed(speed: number): void;
  step(dt: number): void;
  readMaterial(): BodyPose;
  hasSupport(): boolean;
  dispose(): void;
}

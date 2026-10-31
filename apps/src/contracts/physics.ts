import type { Vec3 } from "./device";
export type Quat = [number, number, number, number];
export interface BodyPose {
  position: Vec3;
  rotation: Quat;
  velocity: Vec3;
  angularVelocity?: Vec3;
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
  bodies?: RuntimeBody[];
  surfaces?: RuntimeSurface[];
  targetBodyId?: string;
}
export interface PhysicsPort {
  setSurfaceSpeed(speed: number): void;
  step(dt: number): void;
  readMaterial(): BodyPose;
  hasSupport(bodyId?: string, surfaceId?: string): boolean;
  readBody?(bodyId: string): BodyPose;
  moveTool?(bodyId: string, pose: BodyPose, dt: number): void;
  createGrasp?(id: string, tool: string, material: string): void;
  removeGrasp?(id: string): void;
  hasGrasp?(id: string): boolean;
  dispose(): void;
}

export interface RuntimeBody {
  id: string;
  instanceId: string;
  motionType: "static" | "dynamic" | "kinematic";
  role: "conveying_support" | "material" | "ground" | "tool";
  position: Vec3;
  rotation: Quat;
  size: Vec3;
  mass?: number;
  friction: number;
  restitution: number;
}
export interface RuntimeSurface {
  id: string;
  bodyId: string;
  direction: Vec3;
  normal: Vec3;
}

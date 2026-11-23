import type { Vec3 } from "./device";
export type Quat = [number, number, number, number];
export type { Vec3 } from "./device";
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
  carrierBindings?: { carrier: string; material: string }[];
}
export interface PhysicsPort {
  isMotionStopped?(): boolean;
  setSurfaceSpeed(speed: number): void;
  setSurfaceSpeeds?(speeds: Readonly<Record<string, number>>): void;
  getSurfaceSpeed?(surfaceId: string): number;
  isBodyActive?(bodyId: string): boolean;
  activateBodies?(placements: readonly { id: string; pose: BodyPose }[]): void;
  deactivateBodies?(ids: readonly string[]): void;
  hasGraspForBody?(id: string): boolean;
  isCarriedBy?(material: string, carrier?: string): boolean;
  step(dt: number): void;
  readMaterial(): BodyPose;
  hasSupport(bodyId?: string, surfaceId?: string): boolean;
  readBody?(bodyId: string): BodyPose;
  moveTool?(bodyId: string, pose: BodyPose, dt: number): void;
  moveKinematicBody?(bodyId: string, pose: BodyPose, dt: number): void;
  placeEmptyTool?(bodyId: string, pose: BodyPose): void;
  bindLoad?(carrier: string, material: string, fromGrasp?: string): void;
  hasContactSupport?(bodyId: string, supportId: string): boolean;
  createGrasp?(id: string, tool: string, material: string): void;
  transferGrasp?(
    from: string,
    to: string,
    tool: string,
    material: string,
  ): void;
  removeGrasp?(id: string): void;
  hasGrasp?(id: string): boolean;
  dispose(): void;
}

export interface RuntimeBody {
  sensor?: boolean;
  convexParts?: Vec3[][];
  initiallyActive?: boolean;
  id: string;
  instanceId: string;
  motionType: "static" | "dynamic" | "kinematic";
  role:
    | "conveying_support"
    | "material"
    | "ground"
    | "tool"
    | "carrier"
    | "support";
  position: Vec3;
  rotation: Quat;
  size: Vec3;
  mass?: number;
  friction: number;
  restitution: number;
}
export interface RuntimeSurface {
  aliases?: string[];
  id: string;
  bodyId: string;
  direction: Vec3;
  normal: Vec3;
}

import type { Vec3 } from "./device";
import type { PhysicsConfig, BodyPose } from "./physics";
import type { RuntimeSignal } from "./runtime-signals";
export interface CompiledRuntimeScene {
  instanceId: string;
  subjectId: string;
  revision: number;
  templateId: string;
  physics: PhysicsConfig;
  materialInstanceId?: string;
  bodyLocalMatrix?: number[];
  speed: number;
  referenceSpeed: number;
  accelTime: number;
  decelTime: number;
  origin: Vec3;
  yaw: number;
  entry: [number, number];
  regionHeight: [number, number];
  speedTolerance: number;
  exit: [number, number];
  timeout: number;
}
export interface RuntimeRequest {
  requestId: string;
  subjectId: string;
  status: "waiting" | "busy" | "succeeded" | "failed" | "cancelled";
  reason?: string;
}
export interface RuntimeSnapshot {
  status:
    | "idle"
    | "preparing"
    | "ready"
    | "running"
    | "paused"
    | "stopped"
    | "failed";
  tick: number;
  time: number;
  instanceId?: string;
  subjectId?: string;
  pose?: BodyPose;
  size?: Vec3;
  materialInstanceId?: string;
  bodyLocalMatrix?: number[];
  signals: Record<string, RuntimeSignal>;
  supported: boolean;
  atExit: boolean;
  request: RuntimeRequest | null;
  error?: string;
}

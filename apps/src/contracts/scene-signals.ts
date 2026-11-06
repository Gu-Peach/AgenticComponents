export type SignalScalar = boolean | number;
export type SignalQuality =
  "unknown" | "good" | "stale" | "invalid" | "disconnected";
export interface SceneSignalDefinition {
  key: string;
  direction: "input" | "output";
  type: "BOOL" | "INT" | "DINT" | "REAL";
  unit?: string;
  min?: number;
  max?: number;
  writer: string;
  maxAgeTicks?: number;
}
export interface SignalIdentity {
  runId: string;
  requestId?: string;
  subjectId?: string;
  activationId?: string;
}
export interface SceneSignalSample extends SignalIdentity {
  value: SignalScalar | null;
  quality: SignalQuality;
  sampledTick: number;
  changedTick: number;
  writer: string;
}
export interface SignalWrite extends SignalIdentity {
  key: string;
  writer: string;
  value: SignalScalar | null;
  quality?: Exclude<SignalQuality, "stale">;
}
export interface SceneSignalFrame {
  runId: string;
  tick: number;
  revision: number;
  samples: Readonly<Record<string, Readonly<SceneSignalSample>>>;
}
export interface SignalChange {
  sequence: number;
  key: string;
  tick: number;
  sample: Readonly<SceneSignalSample>;
}

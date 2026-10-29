import type {
  BehaviorContract,
  DeviceDefinition,
  DeviceInstance,
  ParamValue,
  Transform,
} from "./device";
export type PreviewStatus =
  | "idle"
  | "preparing"
  | "running"
  | "paused"
  | "stopping"
  | "succeeded"
  | "cancelled"
  | "failed";
export interface PreviewIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
  path?: string;
}
export interface PreviewRequest {
  requestId: string;
  instanceId: string;
  behaviorId: string;
  definitionRevision: string;
  sceneRevision: number;
  args: Record<string, ParamValue>;
  mode: "real" | "mock";
}
export interface PreviewResult {
  requestId: string;
  status: "succeeded" | "cancelled" | "failed";
  evidence: "observed" | "mock";
  observations: Record<string, ParamValue>;
  issues: PreviewIssue[];
}
export interface ResolvedPreviewInput {
  request: PreviewRequest;
  definition: DeviceDefinition;
  instance: DeviceInstance;
  behavior: BehaviorContract;
  parameters: Record<string, ParamValue>;
  affectedInstanceIds: string[];
}
export interface NodePose {
  position: Transform["position"];
  quaternion: [number, number, number, number];
}
/** Node access is restricted to the objects owned by this session. No React/three dependency. */
export interface PreviewContext {
  hasNode(instanceId: string, nodeName: string): boolean;
  readNode(instanceId: string, nodeName: string): NodePose | null;
  writeNode(instanceId: string, nodeName: string, pose: NodePose): void;
  log(message: string): void;
}
export interface PreviewFrame {
  observations: Record<string, ParamValue>;
  progress?: number;
}
export interface ExecutorCapabilities {
  supportedBehaviors: string[];
  supportsPause: boolean;
  supportsRestore: boolean;
}
export interface AnimationAdapter {
  readonly id: string;
  capabilities(): ExecutorCapabilities;
  validate(input: ResolvedPreviewInput): PreviewIssue[];
  prepare(
    input: ResolvedPreviewInput,
    context: PreviewContext,
    signal: AbortSignal,
  ): Promise<PreviewSession>;
}
export interface PreviewSession {
  readonly sessionId: string;
  start(): void;
  tick(dt: number, simulationTime: number): PreviewFrame;
  pause(): void;
  resume(): void;
  stop(reason: string): Promise<PreviewResult>;
  result(): PreviewResult | null;
  restoreBaseline(): Promise<void>;
  dispose(): void;
}
export interface PreviewSnapshot {
  status: PreviewStatus;
  request?: PreviewRequest;
  time: number;
  progress: number;
  observations: Record<string, ParamValue>;
  result?: PreviewResult;
  error?: string;
  supportsPause: boolean;
  supportsRestore: boolean;
}
export const isActive = (s: PreviewStatus) =>
  ["preparing", "running", "paused", "stopping"].includes(s);

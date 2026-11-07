import type { ProcessNode, Expression } from "./process-ir";
import type { SceneSignalFrame } from "./scene-signals";
import type {
  ConditionContext,
  ConditionProviderPort,
  ObservationFrame,
} from "./conditions";
export interface ActionRequest {
  runId: string;
  activationId: string;
  requestId: string;
  device: string;
  behavior: string;
  subjectId?: string;
  arguments: Readonly<Record<string, unknown>>;
  payload?: unknown;
}
export interface ActionFeedback {
  runId: string;
  activationId: string;
  requestId: string;
  device: string;
  status: "accepted" | "succeeded" | "failed" | "stopped";
  reason?: string;
}
export type ActionEffect = {
  kind: "submit" | "cancel";
  request: ActionRequest;
};
export interface ActionBinding {
  device: string;
  behavior: string;
  continuous?: boolean;
  preconditions: readonly string[];
  authorization: readonly string[];
  sustaining: readonly string[];
  completion: readonly string[];
  release: readonly string[];
  stopped: readonly string[];
  resources(
    context: ConditionContext,
    args: Readonly<Record<string, unknown>>,
  ): readonly string[];
  validateArguments(
    args: Readonly<Record<string, unknown>>,
    payload: unknown,
  ): void;
}
export interface SchedulerDeadlines {
  preconditions: number;
  acceptance: number;
  execution: number;
  stop: number;
  collection: number;
  finalization: number;
}
export type ExpressionReader = (
  args: readonly unknown[],
  kwargs: Readonly<Record<string, unknown>>,
  context: ConditionContext,
) => unknown;
export interface BoundProcess {
  root: ProcessNode;
  scope: Readonly<Record<string, unknown>>;
  actions: ReadonlyMap<string, ActionBinding>;
  providers: ConditionProviderPort;
  readers: Readonly<Record<string, ExpressionReader>>;
  finalization: readonly string[];
  iterationGates: Readonly<
    Record<string, { entry: readonly string[]; completion: readonly string[] }>
  >;
  deadlines: SchedulerDeadlines;
}
export interface SchedulerSnapshot {
  runId: string;
  tick: number;
  status:
    | "running"
    | "finalizing"
    | "succeeded"
    | "stopping"
    | "failed"
    | "cancelled"
    | "attention_required";
  error?: string;
  activations: {
    id: string;
    node: string;
    state: string;
    requestId?: string;
    subjectId?: string;
    parentId?: string;
    iteration?: number;
    totalIterations?: number;
    selectedChild?: string;
    blockedBy: readonly string[];
  }[];
  resources: Record<string, string>;
}
export type SchedulerInput = {
  frame: Readonly<SceneSignalFrame>;
  feedback: readonly ActionFeedback[];
  observations?: Readonly<ObservationFrame>;
};
export type Evaluator = (e: Expression, context: ConditionContext) => unknown;

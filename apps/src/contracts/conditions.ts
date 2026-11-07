import type {
  SceneSignalFrame,
  SignalIdentity,
  SignalQuality,
} from "./scene-signals";
import type {
  ConditionPhase,
  ConditionDiagnostics,
} from "./condition-expression";
export type Truth = boolean | undefined;
export interface ObservationWrite extends SignalIdentity {
  key: string;
  provider: string;
  value: unknown;
  quality?: Exclude<SignalQuality, "stale">;
}
export interface ObservationDefinition {
  key: string;
  provider: string;
  maxAgeTicks: number;
  validate(value: unknown): boolean;
}
export interface ObservationSample extends Omit<ObservationWrite, "quality"> {
  quality: SignalQuality;
  sampledTick: number;
}
export interface ObservationFrame {
  runId: string;
  tick: number;
  samples: Readonly<Record<string, Readonly<ObservationSample>>>;
}
export interface ConditionContext {
  nodeId?: string;
  activationId?: string;
  phase?: ConditionPhase;
  requestState?: Readonly<{
    accepted: boolean;
    outcome?: "succeeded" | "failed";
    stopped: boolean;
  }>;
  frame: Readonly<SceneSignalFrame>;
  tick: number;
  scope: Readonly<Record<string, unknown>>;
  request?: SignalIdentity & {
    device: string;
    requestId: string;
    activationId: string;
  };
  observations?: Readonly<ObservationFrame>;
  owns(resource: string): boolean;
}
export interface ConditionProvider {
  dependencies?: readonly string[];
  evaluate(
    context: ConditionContext,
    dependencies: Readonly<Record<string, Truth>>,
  ): Truth;
}
export interface ConditionProviderPort {
  diagnostics?(): ConditionDiagnostics | undefined;
  validate(ids: readonly string[]): void;
  evaluate(id: string, context: ConditionContext): Truth;
  all(ids: readonly string[], context: ConditionContext): Truth;
}

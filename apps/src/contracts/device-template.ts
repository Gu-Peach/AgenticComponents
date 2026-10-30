import type { RuntimeRequest } from "./runtime";
import type { CompiledRuntimeScene } from "./runtime";
interface SurfaceDrive {
  setSurfaceSpeed(speed: number): void;
}
import type { SignalValue } from "./runtime-signals";
export interface DeviceObservation {
  dt: number;
  tick: number;
  appliedSpeed: number;
  support: boolean;
  atExit: boolean;
  entryClear: boolean;
  request: RuntimeRequest | null;
  publish(id: string, value: SignalValue): void;
}
interface SignalAccess {
  read(id: string): SignalValue;
}
export interface DeviceScript {
  beforePhysics(dt: number, signals: SignalAccess, physics: SurfaceDrive): void;
  afterPhysics(observation: DeviceObservation): void;
  dispose(): void;
}
export interface DeviceTemplate {
  id: string;
  version: string;
  create(config: Readonly<CompiledRuntimeScene>): DeviceScript;
}

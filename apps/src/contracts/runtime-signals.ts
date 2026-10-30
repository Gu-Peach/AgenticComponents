export type SignalValue = boolean | number;
export interface RuntimeSignal {
  value: SignalValue;
  valid: boolean;
  tick: number;
  writer: string;
}
export interface SignalCommand {
  portId: string;
  value: SignalValue;
  writer: "manual";
}

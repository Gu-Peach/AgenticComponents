import type { RuntimeSnapshot } from "./runtime";
import type { RobotCommand } from "./robot-command";
export interface RuntimeProgram {
  step(dt: number): RuntimeSnapshot;
  snapshot(): RuntimeSnapshot;
  stop(): RuntimeSnapshot;
  command?(id: string, value: boolean | number): void;
  submitAction?(command: RobotCommand): void;
}

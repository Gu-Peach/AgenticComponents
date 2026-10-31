import type { RuntimeScene } from "@/contracts/runtime";
import type { PhysicsPort } from "@/contracts/physics";
import type { RobotCommand } from "@/contracts/robot-command";
import { ConveyorProgram } from "@/runtime/programs/ConveyorProgram";
import { RobotProgram } from "@/runtime/programs/RobotProgram";
import { createRuntimeProgram } from "@/runtime/programs/RuntimeProgramFactory";
export class RuntimeKernel {
  private program: ConveyorProgram | RobotProgram;
  constructor(
    readonly scene: RuntimeScene,
    physics?: PhysicsPort,
  ) {
    this.program = createRuntimeProgram(scene, physics);
  }
  get signals() {
    return this.program.signals;
  }
  /** Compatibility surface for transport arrival observers. */
  get tasks() {
    if (!(this.program instanceof ConveyorProgram))
      throw new Error("机械臂不使用输送到达观察器");
    return this.program.tasks;
  }
  step(dt: number) {
    if (!Number.isFinite(dt) || Math.abs(dt - 1 / 60) > 1e-8)
      throw new Error("只接受固定1/60秒逻辑步");
    return this.program.step(dt);
  }
  command(id: string, value: boolean | number) {
    if (this.program instanceof RobotProgram) this.program.command(id, value);
    else this.program.signals.command(id, value);
  }
  submitAction(command: RobotCommand) {
    if (!(this.program instanceof RobotProgram))
      throw new Error("不是机械臂会话");
    this.program.submitAction(command);
  }
  pickPlaceCommand(id: number) {
    if (!(this.program instanceof RobotProgram))
      throw new Error("不是机械臂会话");
    return this.program.pickPlaceCommand(id);
  }
  snapshot() {
    return this.program.snapshot();
  }
  stop() {
    return this.program.stop();
  }
}

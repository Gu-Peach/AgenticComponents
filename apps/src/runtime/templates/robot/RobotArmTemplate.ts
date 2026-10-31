import type { CompiledRobotScene } from "@/contracts/robot";
import type { PhysicsPort } from "@/contracts/physics";
import { SignalRegistry } from "@/runtime/engine/SignalRegistry";
import { RobotJobRunner } from "./RobotJobRunner";
import { RobotState } from "./RobotState";
export const RobotArmTemplate = {
  id: "robot.articulated",
  version: "1",
  create(
    scene: CompiledRobotScene,
    signals: SignalRegistry,
    physics?: PhysicsPort,
  ) {
    const state = new RobotState();
    return {
      state,
      runner: new RobotJobRunner(scene, state, signals, physics),
    };
  },
};

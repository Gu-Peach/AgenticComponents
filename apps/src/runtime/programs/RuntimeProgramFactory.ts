import type { RuntimeScene } from "@/contracts/runtime";
import type { PhysicsPort } from "@/contracts/physics";
import { ConveyorProgram } from "./ConveyorProgram";
import { RobotProgram } from "./RobotProgram";
export function createRuntimeProgram(
  scene: RuntimeScene,
  physics?: PhysicsPort,
) {
  if (scene.kind === "robot_experiment")
    return new RobotProgram(scene, physics);
  if (!physics) throw new Error("输送实验需要物理后端");
  return new ConveyorProgram(scene, physics);
}

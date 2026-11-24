/** 根据已编译的单设备场景类型创建机械臂或输送带运行程序，并为输送仿真检查物理后端。 */

import { getDeviceModule } from "@/devices/registry";
import type { RuntimeScene } from "@/contracts/runtime";
import type { PhysicsPort } from "@/contracts/physics";
export function createRuntimeProgram(
  scene: RuntimeScene,
  physics?: PhysicsPort,
) {
  if (scene.kind === "robot_experiment")
    return getDeviceModule("robot_arm").createProgram(scene, physics);
  if (!physics) throw new Error("输送实验需要物理后端");
  return getDeviceModule("conveyor").createProgram(scene, physics);
}

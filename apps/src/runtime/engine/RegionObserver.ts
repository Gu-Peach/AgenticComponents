import type { CompiledRuntimeScene } from "@/contracts/runtime";
import type { BodyPose } from "@/contracts/physics";
export function observeRegions(
  scene: CompiledRuntimeScene,
  pose: BodyPose,
  support: boolean,
) {
  const dx = pose.position[0] - scene.origin[0],
    dz = pose.position[2] - scene.origin[2],
    x = Math.cos(scene.yaw) * dx - Math.sin(scene.yaw) * dz;
  const z = Math.sin(scene.yaw) * dx + Math.cos(scene.yaw) * dz;
  const atExit =
    support &&
    x >= scene.exit[0] &&
    x <= scene.exit[1] &&
    Math.abs(z) < scene.physics.surfaceSize[2] / 2;
  const y = pose.position[1] - scene.origin[1];
  return {
    entryClear: !(
      x >= scene.entry[0] &&
      x <= scene.entry[1] &&
      Math.abs(z) < scene.physics.surfaceSize[2] / 2 &&
      y >= scene.regionHeight[0] &&
      y <= scene.regionHeight[1]
    ),
    atExit,
    fallen: y < 0.2,
  };
}

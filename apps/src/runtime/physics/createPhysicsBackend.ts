/** 按需加载 Jolt 后端，根据物理配置创建仿真使用的物理世界。 */

import type { PhysicsConfig } from "@/contracts/physics";
export async function createPhysicsBackend(config: PhysicsConfig) {
  const { createJoltBackend } = await import("./jolt/JoltPhysicsBackend");
  return createJoltBackend(config);
}

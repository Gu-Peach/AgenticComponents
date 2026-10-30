import type { PhysicsConfig } from "@/contracts/physics";
export async function createPhysicsBackend(config: PhysicsConfig) {
  const { createJoltBackend } = await import("./jolt/JoltPhysicsBackend");
  return createJoltBackend(config);
}

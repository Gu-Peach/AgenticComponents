import fixture from "@/data/runtime-fixtures/conveyor-box.json";
import type { Vec3 } from "@/contracts/device";
export function compileMaterial() {
  if (fixture.mass <= 0 || fixture.size.some((n) => n <= 0))
    throw new Error("物料质量和尺寸必须为正数");
  return {
    size: fixture.size as Vec3,
    position: fixture.position as Vec3,
    mass: fixture.mass,
  };
}

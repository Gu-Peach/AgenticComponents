import { it, expect } from "vitest";
import { createJoltBackend } from "../../src/runtime/physics/jolt/JoltPhysicsBackend";
import type { PhysicsConfig, RuntimeBody } from "../../src/contracts/physics";
const cube = (
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
): [number, number, number][] =>
  [-1, 1].flatMap((a) =>
    [-1, 1].flatMap((b) =>
      [-1, 1].map(
        (c) =>
          [x + (a * sx) / 2, y + (b * sy) / 2, z + (c * sz) / 2] as [
            number,
            number,
            number,
          ],
      ),
    ),
  );
it("holds stacked offset compound shapes on a physical support", async () => {
  const fixed: RuntimeBody = {
    id: "floor",
    instanceId: "floor",
    role: "conveying_support",
    motionType: "static",
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    size: [3, 0.2, 3],
    friction: 0.6,
    restitution: 0,
  };
  const carrier: RuntimeBody = {
    ...fixed,
    id: "carrier",
    instanceId: "carrier",
    role: "carrier",
    motionType: "dynamic",
    position: [0, 0.25, 0],
    size: [1, 0.3, 1],
    mass: 2,
    convexParts: [
      cube(-0.3, -0.1, 0, 0.2, 0.1, 1),
      cube(0.3, -0.1, 0, 0.2, 0.1, 1),
      cube(0, 0.1, 0, 1, 0.1, 1),
    ],
  };
  const load: RuntimeBody = {
    ...carrier,
    id: "part",
    instanceId: "part",
    role: "material",
    position: [0.2, 0.5, 0],
    mass: 1,
    size: [0.2, 0.2, 0.2],
    convexParts: [cube(0, 0, 0, 0.2, 0.2, 0.2)],
  };
  const config: PhysicsConfig = {
    bodies: [fixed, carrier, load],
    surfaces: [
      { id: "floor", bodyId: "floor", direction: [1, 0, 0], normal: [0, 1, 0] },
    ],
    targetBodyId: "part",
    surfacePosition: [0, 0, 0],
    surfaceSize: [3, 0.2, 3],
    rotation: [0, 0, 0, 1],
    materialPosition: load.position,
    materialSize: load.size,
    mass: 1,
    friction: 0.6,
  };
  const physics = await createJoltBackend(config);
  try {
    for (let i = 0; i < 300; i++) physics.step(1 / 60);
    expect(physics.readBody!("part").position[1]).toBeCloseTo(0.5, 2);
    expect(Math.hypot(...physics.readBody!("part").velocity)).toBeLessThan(
      0.02,
    );
    expect(physics.hasSupport("part", "carrier")).toBe(true);
  } finally {
    physics.dispose();
  }
});

import { it, expect } from "vitest";
import { robotSetup } from "./robot-helpers";
import { createJoltBackend } from "../src/runtime/physics/jolt/JoltPhysicsBackend";
import { RobotKinematics } from "../src/runtime/kinematics/RobotKinematics";
import { RobotSceneAdapter } from "../src/runtime/adapters/scene/RobotSceneAdapter";
it("executes a scene robot against the shared Jolt world without stepping it inside the adapter", async () => {
  const { scene } = robotSetup();
  scene.model.urdf.joints.forEach((j) => (j.limit = null));
  const fk = new RobotKinematics(scene),
    initial = fk.forward([0, 0, 0, 0, 0, 0]).tcp,
    target = fk.forward([0.15, 0.1, -0.15, 0, 0, 0]).tcp;
  const physics = await createJoltBackend({
    surfacePosition: [0, -1, 0],
    surfaceSize: [4, 0.1, 4],
    rotation: [0, 0, 0, 1],
    materialPosition: initial.position,
    materialSize: [0.025, 0.025, 0.025],
    mass: 1,
    friction: 0.5,
    targetBodyId: scene.toolBodyId,
    bodies: [
      {
        id: scene.toolBodyId,
        instanceId: scene.instanceId,
        motionType: "kinematic",
        role: "tool",
        position: initial.position,
        rotation: initial.rotation,
        size: [0.025, 0.025, 0.025],
        friction: 0.5,
        restitution: 0,
      },
    ],
    surfaces: [],
  });
  const driver = new RobotSceneAdapter("S", "run", scene, physics, () => ({
    scene,
    steps: [
      { kind: "move_to_pose", position: target.position, frame: "world" },
    ],
  }));
  const request = {
    runId: "run",
    activationId: "move",
    requestId: "1",
    device: scene.instanceId,
    behavior: "move_to_pose",
    arguments: {},
  };
  try {
    const initialPose = physics.readBody!(scene.toolBodyId);
    driver.prepare(request, {
      runId: "run",
      tick: 0,
      revision: 0,
      samples: {},
    });
    expect(physics.readBody!(scene.toolBodyId)).toEqual(initialPose);
    driver.submit(request);
    let success = false;
    for (let tick = 1; tick < 1200; tick++) {
      driver.beforePhysics(1 / 60, tick);
      physics.step(1 / 60);
      driver.afterPhysics(1 / 60, tick);
      if (driver.drainFeedback().some((f) => f.status === "succeeded")) {
        success = true;
        break;
      }
    }
    expect(success).toBe(true);
    expect(
      Math.hypot(
        ...physics.readBody!(scene.toolBodyId).position.map(
          (v, i) => v - target.position[i],
        ),
      ),
    ).toBeLessThanOrEqual(scene.tolerance);
    expect(driver.isStopped()).toBe(true);
    driver.requestStop();
    driver.beforePhysics(1 / 60, 1201);
    physics.step(1 / 60);
    driver.afterPhysics(1 / 60, 1201);
    expect(
      driver
        .drainSignals()
        .filter((s) => s.key.endsWith("/done"))
        .at(-1)?.value,
    ).toBe(true);
    driver.dispose();
  } finally {
    physics.dispose();
  }
});

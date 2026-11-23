import { expect, it } from "vitest";
import { Group, Object3D, Quaternion, Vector3 } from "three";
import { bindSceneVisuals } from "../src/renderer/bindSceneVisuals";
import type { SceneRuntimeSnapshot } from "../src/runtime/engine/SceneRuntimeProgram";
import type { BodyPose } from "../src/contracts/physics";
import type { VisualBodyBinding } from "../src/contracts/scene-execution";
import { sceneFixture } from "./assembly/fixtures";
import { compileSceneRobot } from "../src/domain/runtime/compileSceneRobot";

type VisualSample = Pick<
  SceneRuntimeSnapshot,
  "tick" | "status" | "observations" | "runId"
>;
function pose(x: number, yaw = 0): BodyPose {
  return {
    position: [x, 0, 0],
    rotation: new Quaternion()
      .setFromAxisAngle(new Vector3(0, 1, 0), yaw)
      .toArray(),
    velocity: [0, 0, 0],
  };
}
function sample(
  tick: number,
  x: number,
  active = true,
  angle = 0,
  status = "running",
): VisualSample {
  const runId = "render-test";
  const identity = {
    provider: "test",
    quality: "good" as const,
    sampledTick: tick,
    runId,
  };
  return {
    runId,
    tick,
    status,
    observations: {
      runId,
      tick,
      samples: {
        "world/state": {
          ...identity,
          key: "world/state",
          value: {
            bodies: {
              original: { active: true, pose: pose(x, angle) },
              future: { active, pose: pose(x + 10) },
            },
          },
        },
        "arm/robot_state": {
          ...identity,
          key: "arm/robot_state",
          value: { q: [angle, 0, 0, 0, 0, 0] },
        },
      },
    },
  };
}

it("interpolates consecutive simulation poses and joints between PLC updates and snaps to the paused pose", () => {
  const { bundle } = sceneFixture("S02");
  const robot = compileSceneRobot(
    bundle.devices.find((d) => d.instance_id === "R1"),
    0,
    { allowCandidate: true },
  );
  const model = new Group(),
    mesh = new Object3D(),
    joint = new Object3D();
  mesh.position.set(0.25, 0, 0);
  mesh.userData.sceneNodeIndex = 1;
  joint.userData.sceneNodeIndex = 2;
  model.add(mesh, joint);
  const binding: VisualBodyBinding = {
    bodyId: "original",
    instanceId: "original",
    initial: pose(0),
    meshes: [1],
    future: false,
  };
  const visual = bindSceneVisuals(model, {
    visualBodies: [binding],
    robotNodes: new Map([["arm", [2]]]),
    robots: new Map([["arm", robot]]),
  });
  const previous = sample(0, 0, false, 0),
    current = sample(1, 1, true, Math.PI / 2);
  const group = model.getObjectByName("runtime:original")!;
  for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
    visual.apply({ previous, current, alpha });
    expect(group.position.x).toBeCloseTo(alpha);
    expect(
      group.quaternion.angleTo(
        new Quaternion().fromArray(pose(0, (Math.PI / 2) * alpha).rotation),
      ),
    ).toBeLessThan(1e-7);
    const axis = new Vector3(...robot.model.urdf.joints[0].axis);
    expect(
      joint.quaternion.angleTo(
        new Quaternion().setFromAxisAngle(axis, (Math.PI / 2) * alpha),
      ),
    ).toBeLessThan(1e-7);
  }
  visual.apply({
    previous,
    current: { ...current, status: "paused" },
    alpha: 0.2,
  });
  expect(group.position.x).toBe(1);
  visual.dispose();
  expect(mesh.parent).toBe(model);
  expect(mesh.position.x).toBe(0.25);
  expect(joint.quaternion.angleTo(new Quaternion())).toBe(0);
  expect(model.getObjectByName("runtime:original")).toBeUndefined();
});

it("instantiates future mesh groups on admission and skips interpolation across absence or run changes", () => {
  const model = new Group(),
    mesh = new Object3D();
  mesh.userData.sceneNodeIndex = 1;
  model.add(mesh);
  const original: VisualBodyBinding = {
    bodyId: "original",
    instanceId: "original",
    meshes: [1],
    future: false,
    initial: pose(0),
  };
  const future = {
    ...original,
    bodyId: "future",
    instanceId: "future",
    future: true,
  };
  const visual = bindSceneVisuals(model, {
    visualBodies: [original, future],
    robots: new Map(),
    robotNodes: new Map(),
  });
  const absent = sample(0, 0, false),
    present = sample(1, 2);
  visual.apply({ previous: absent, current: absent, alpha: 1 });
  expect(model.getObjectByName("runtime:future")).toBeUndefined();
  visual.apply({ previous: absent, current: present, alpha: 0 });
  const clone = model.getObjectByName("runtime:future")!;
  expect(clone.position.x).toBe(12);
  expect(clone.children[0]).not.toBe(mesh);
  visual.apply({ previous: present, current: sample(2, 3, false), alpha: 0 });
  expect(clone.parent).toBeNull();
  visual.apply({
    previous: { ...absent, runId: "last" },
    current: present,
    alpha: 0,
  });
  expect(model.getObjectByName("runtime:original")!.position.x).toBe(2);
  visual.dispose();
  expect(model.children).toEqual([mesh]);
});

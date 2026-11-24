import { expect, it } from "vitest";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";
import { sceneFixture } from "./fixtures";

it("binds the real turntable rotor, right hand and workpiece interfaces to a finite batch", () => {
  const { bundle, bytes, goal } = sceneFixture("S11");
  const compiled = compileSceneRuntime(bundle, bytes, goal, "validation");
  const cfg = compiled.indexedProcessing!;
  expect(cfg.jobs.length).toBe(4);
  expect(
    compiled.physics.bodies?.filter(
      (b) => b.role === "material" && b.initiallyActive,
    ),
  ).toHaveLength(1);
  const rotor = compiled.visualBodies.find((b) => b.bodyId === cfg.tableBody)!;
  const table = compiled.devices.get(cfg.table)!;
  expect(rotor.meshes.length).toBeLessThan(
    table.node_binding.owned_mesh_indices.length,
  );
  expect(rotor.meshes.length).toBeGreaterThan(0);
  expect(Math.hypot(cfg.slotOffset[0], cfg.slotOffset[2])).toBeCloseTo(0.48, 2);
  const human = compiled.visualBodies.find((b) => b.bodyId === cfg.humanBody)!;
  expect(human.meshes).toEqual(
    compiled.devices.get(cfg.human)!.node_binding.owned_mesh_indices,
  );
  for (const j of cfg.jobs) {
    const f = cfg.materialFrames.get(j.material)!;
    expect(f.graspInterface).not.toBe(f.processInterface);
    expect(f.grasp.offset).not.toEqual(f.process.offset);
  }
  expect(compiled.robotNodes.get(cfg.robot)).toHaveLength(6);
});

it("rejects redirected processing goals and incompatible tool interfaces before creating a world", () => {
  const { bundle, bytes, goal } = sceneFixture("S11");
  const requirement = goal.all.find(
    (g: { kind: string }) => g.kind === "required_operations",
  ).recipes.welding;
  const original = requirement.station;
  requirement.station = "missing";
  expect(() => compileSceneRuntime(bundle, bytes, goal, "validation")).toThrow(
    /station binding/,
  );
  requirement.station = original;
  const robot = bundle.devices.find(
    (d) => d.contract.device_type === "robot_arm",
  )!;
  const interfaces = robot.contract.interfaces as {
    capabilities: { snap: { role: string; accepts: string[] } };
  }[];
  interfaces.find(
    (p) => p.capabilities.snap.role === "weld_tool",
  )!.capabilities.snap.accepts = [];
  expect(() => compileSceneRuntime(bundle, bytes, goal, "validation")).toThrow(
    /interfaces differ/,
  );
});

import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
import { Quaternion, Vector3 } from "three";
import { compileTransportTargets } from "../src/domain/runtime/compileTransportTargets";
import { compileSceneRobot } from "../src/domain/runtime/compileSceneRobot";
import { RobotKinematics } from "../src/runtime/kinematics/RobotKinematics";
import { CcdPositionIK } from "../src/runtime/kinematics/CcdPositionIK";
import { sceneBundleSchema } from "../src/contracts/scene-package";
import { sceneModules } from "../src/domain/runtime/sceneModules";
interface EvidenceDevice {
  instance_id: string;
  geometry: {
    world_position: [number, number, number];
    world_rotation: [number, number, number, number];
    bounds: { min: [number, number, number]; max: [number, number, number] };
  };
  locations: Record<string, { position: [number, number, number] }>;
  parameters: { height_m: number };
}
const read = (file: string) =>
  JSON.parse(readFileSync("public/scene/S01/" + file, "utf8"));
it("uses one scene-owned work point and one coupled leader without authored travel distances", () => {
  const scene = read("scene.json"),
    source = readFileSync("public/scene/S01/process.py", "utf8");
  expect(source).not.toMatch(/to_work_m|to_exit_m|move_by_distance/);
  const targets = compileTransportTargets(
    scene,
    "C2",
    read("device/C2.json").locations,
  );
  expect(targets.find((t) => t.id === "scene.sorting")?.position).toEqual(
    scene.sorting_station.position_m,
  );
  expect(targets.find((t) => t.id === "C2.exit")?.position).toEqual(
    read("device/C2.json").locations["C2.exit"].position,
  );
  const bundle = sceneBundleSchema.parse(read(".generated/scene.bundle.json"));
  expect(
    bundle.calls
      .filter((c) => c.behavior === "transport_to_position")
      .map((c) => c.device),
  ).toEqual(["C2", "C2"]);
  const follower = sceneModules(bundle).find((d) => d.id === "C1")!;
  expect(follower.calls).toHaveLength(0);
  expect(follower.groupedBy).toEqual(["C2"]);
});
it("derives metre-normalized FK and unbounded candidate IK from the current scene, without promoting calibration", () => {
  const bundle = read(".generated/scene.bundle.json"),
    devices = new Map<string, EvidenceDevice>(
      bundle.devices.map((d: EvidenceDevice) => [d.instance_id, d]),
    );
  const pallet = devices.get("P01")!,
    rotation = new Quaternion(
      ...(pallet.geometry.world_rotation as [number, number, number, number]),
    );
  for (const id of ["R1", "R2"]) {
    const device = devices.get(id)!;
    expect(() => compileSceneRobot(device, 0)).toThrow("candidate");
    const scene = compileSceneRobot(device, 0, { allowCandidate: true });
    const fk = new RobotKinematics(scene),
      solver = new CcdPositionIK(fk);
    expect(scene.model.urdf.joints.every((j) => j.limit === null)).toBe(true);
    expect(
      new Vector3(...fk.forward([0, 0, 0, 0, 0, 0]).tcp.position).distanceTo(
        new Vector3(
          ...(device.locations[id + ".home"].position as [
            number,
            number,
            number,
          ]),
        ),
      ),
    ).toBeLessThan(1e-8);
    for (const row of bundle.process.task.pallets[0].items.filter(
      (r: { category: string }) => r.category === (id === "R1" ? "A" : "B"),
    )) {
      const material = devices.get(row.material)!,
        bounds = material.geometry.bounds;
      const center = bounds.min.map(
        (v: number, i: number) => (v + bounds.max[i]) / 2,
      );
      const point = new Vector3(
        ...(pallet.locations[row.source].position as [number, number, number]),
      )
        .applyQuaternion(rotation)
        .add(
          new Vector3(
            ...(bundle.sorting_station.position_m as [number, number, number]),
          ),
        )
        .add(
          new Vector3(...(center as [number, number, number])).sub(
            new Vector3(
              ...(material.geometry.world_position as [number, number, number]),
            ),
          ),
        )
        .add(new Vector3(0, material.parameters.height_m / 2 + 0.025, 0));
      const result = solver.solve(point, [0, 0, 0, 0, 0, 0]);
      expect(result.converged, row.material).toBe(true);
      expect(result.error).toBeLessThanOrEqual(scene.tolerance);
    }
  }
});

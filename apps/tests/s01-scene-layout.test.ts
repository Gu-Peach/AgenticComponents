import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  sceneBundleSchema,
  sortingStationSchema,
} from "../src/contracts/scene-package";
const read = (path: string) =>
  JSON.parse(readFileSync("public/scene/S01/" + path, "utf8"));

it("keeps one scene-owned sorting coordinate and exports it to the loaded package", () => {
  const scene = read("scene.json"),
    c2 = read("device/C2.json"),
    bundle = sceneBundleSchema.parse(read(".generated/scene.bundle.json"));
  expect(scene.schema_version).toBe("scene-package/0.2");
  expect(bundle.sorting_station).toEqual(scene.sorting_station);
  expect(bundle.coordinate_system).toEqual(scene.coordinate_system);
  expect(scene.sorting_station.reference).toBe("carrier_origin");
  expect(scene.sorting_station.support_device).toBe("C2");
  expect(scene.sorting_station.status).toBe("candidate");
  expect(c2.locations["C2.work"]).toBeUndefined();
  for (let axis = 0; axis < 3; axis++)
    expect(scene.sorting_station.position_m[axis]).toBeCloseTo(
      (c2.locations["C2.entry"].position[axis] +
        c2.locations["C2.exit"].position[axis]) /
        2,
      8,
    );
  expect(
    bundle.blockers.some(
      (b) => b.code === "SORTING_STATION_CALIBRATION_REQUIRED",
    ),
  ).toBe(true);
});

it("does not retain conflicting process instructions or duplicate task quantities in scene.json", () => {
  const scene = read("scene.json");
  for (const field of [
    "assumptions",
    "process_assumptions",
    "work_allocation",
    "iteration_contracts",
    "motion_interlocks",
    "lifecycle",
    "execution_defaults",
    "collection_bindings",
    "source_of_truth",
    "legacy_inputs",
  ])
    expect(scene[field]).toBeUndefined();
  expect(scene.environment[0].count).toBeUndefined();
  expect(scene.initial.future_carriers).toBeUndefined();
  expect(scene.execution.tick_hz).toBe(60);
  expect(scene.execution.deadline_ticks).toBe(72000);
});

it("rejects incomplete point definitions and unknown supporting devices", () => {
  const station = read("scene.json").sorting_station;
  expect(() =>
    sortingStationSchema.parse({ ...station, position_m: [1, 2] }),
  ).toThrow();
  expect(() =>
    sortingStationSchema.parse({ ...station, status: "calibrated" }),
  ).toThrow();
  const bundle = read(".generated/scene.bundle.json");
  bundle.sorting_station.support_device = "unknown";
  expect(() => sceneBundleSchema.parse(bundle)).toThrow();
});

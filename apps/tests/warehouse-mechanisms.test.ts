import { expect, it } from "vitest";
import { LinearAxisTrajectory } from "../src/runtime/mechanisms/LinearAxisTrajectory";
import { StorageRackRuntime } from "../src/devices/storage_rack/behavior";
import { resolveDock } from "../src/domain/runtime/DockingTargetResolver";
import { compileSceneRuntime } from "../src/domain/runtime/compileSceneRuntime";
import { warehouseFixture } from "./warehouse-fixtures";

it("brakes a signed moving axis without velocity jumps or limit clamping", () => {
  const a = new LinearAxisTrajectory(0, 0.5, 1, [-2, 2]);
  a.command(-1);
  let previous = 0;
  for (let i = 0; i < 80; i++) {
    a.step(1 / 60);
    expect(Math.abs(a.velocity - previous)).toBeLessThanOrEqual(1 / 60 + 1e-10);
    previous = a.velocity;
  }
  const position = a.position;
  a.stop();
  for (let i = 0; i < 60; i++) a.step(1 / 60);
  expect(a.settled).toBe(true);
  expect(a.position).toBeLessThan(position);
  expect(a.position).toBeGreaterThan(-1);
  expect(() => a.command(3)).toThrow("limits");
});
it("reserves storage atomically and refuses duplicate or foreign commits", () => {
  const s = new StorageRackRuntime(new Set(["slot"]));
  s.reserve("slot", "a");
  expect(() => s.reserve("slot", "b")).toThrow();
  expect(() => s.commit("stored", "slot", "M", "b", 1)).toThrow();
  s.commit("stored", "slot", "M", "a", 1);
  expect(() => s.commit("stored", "slot", "M", "a", 2)).toThrow();
  expect(s.contains("slot", "M")).toBe(true);
  s.reserve("slot", "c", "M");
  s.commit("retrieved", "slot", "M", "c", 3);
  expect(s.snapshot().occupancy).toEqual({});
  expect(s.events.map((e) => e.kind)).toEqual(["stored", "retrieved"]);
});
it("solves named docks along X or Z and rejects targets beyond limits", () => {
  const f = warehouseFixture(1),
    c = compileSceneRuntime(f.bundle, f.bytes, f.goal, "validation").warehouse!;
  const a = c.assemblies[0],
    l = c.locations.get("STORE.slot1")!,
    original = resolveDock(a, l);
  const rotate = (v: number[]) =>
    [v[2] + 4, v[1], -v[0] - 2] as [number, number, number];
  const result = resolveDock(
    { ...a, axis: [0, 0, -1], anchor: rotate(a.anchor) },
    { ...l, position: rotate(l.position) },
  );
  expect(result.rail).toBeCloseTo(original.rail, 6);
  expect(result.lift).toBeCloseTo(original.lift, 6);
  expect(() => resolveDock(a, { ...l, position: [-20, 1, 0] })).toThrow(
    "unreachable",
  );
  expect(() => compileSceneRuntime(f.bundle, f.bytes, f.goal, "run")).toThrow(
    "validation",
  );
});

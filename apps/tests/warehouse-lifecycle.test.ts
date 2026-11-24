import { expect, it } from "vitest";
import { Vector3, Quaternion } from "three";
import { warehouseFixture } from "./warehouse-fixtures";
import { compileSceneRuntime } from "../src/domain/runtime/compileSceneRuntime";
import { assembleSceneRuntime } from "../src/runtime/assembly/SceneRuntimeAssembler";
import type { SceneRuntimeSnapshot } from "../src/runtime/engine/SceneRuntimeProgram";
interface World {
  transfers: Record<
    string,
    { material: string; phase: string; holding: boolean }
  >;
  bodies: Record<string, { pose?: { position: number[] } }>;
}
const world = (s: SceneRuntimeSnapshot) =>
  s.observations.samples["world/state"].value as World;
it("pauses without moving and retains in-flight ownership on cancellation", async () => {
  const f = warehouseFixture(1),
    c = compileSceneRuntime(f.bundle, f.bytes, f.goal, "validation"),
    { program } = await assembleSceneRuntime("stop-scene", "stop-run", c);
  program.start();
  let s = program.snapshot();
  expect(() => program.discard()).toThrow("physically stopped");
  for (let i = 0; i < 5000; i++) {
    s = program.step(1 / 60);
    if (world(s).transfers.L1?.phase === "transferring") break;
  }
  expect(world(s).transfers.L1.holding).toBe(true);
  let previous = new Vector3(...world(s).bodies["M01/body"].pose!.position);
  for (let i = 0; i < 15; i++) {
    s = program.step(1 / 60);
    const next = new Vector3(...world(s).bodies["M01/body"].pose!.position);
    expect(next.distanceTo(previous)).toBeLessThan(0.015);
    previous = next;
  }
  program.pause();
  const frozen = program.snapshot();
  for (let i = 0; i < 10; i++) program.step(1 / 60);
  expect(program.snapshot().tick).toBe(frozen.tick);
  expect(world(program.snapshot()).bodies).toEqual(world(frozen).bodies);
  program.resume();
  program.stop();
  for (let i = 0; i < 2000 && program.needsStep(); i++)
    s = program.step(1 / 60);
  expect(s.status).toBe("attention_required");
  expect(world(s).transfers.L1.holding).toBe(true);
  expect(Object.keys(s.process.resources).length).toBeGreaterThan(0);
  // Held failure is deliberately not disposable through the normal reset path.
  expect(() => program.dispose()).toThrow("unconfirmed");
  program.discard();
  expect(program.snapshot().status).toBe("disposed");
}, 30000);
it("executes the same warehouse profile with renamed devices", async () => {
  const f = warehouseFixture(1),
    names = new Map(
      f.bundle.devices.map((d, i) => [d.instance_id, "Asset" + i]),
    );
  const change = (v: unknown): unknown => {
    if (typeof v === "string") {
      for (const [from, to] of names)
        if (v === from || v.startsWith(from + ".") || v.startsWith(from + "/"))
          return to + v.slice(from.length);
      return v;
    }
    if (Array.isArray(v)) return v.map(change);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, value]) => [change(k), change(value)]),
      );
    return v;
  };
  const c = compileSceneRuntime(
      change(f.bundle) as typeof f.bundle,
      f.bytes,
      change(f.goal),
      "validation",
    ),
    { program } = await assembleSceneRuntime("renamed", "renamed-run", c);
  program.start();
  let s = program.snapshot();
  for (let i = 0; i < 20000 && program.needsStep(); i++)
    s = program.step(1 / 60);
  expect(s.status, s.error).toBe("succeeded");
  program.dispose();
}, 30000);
it("runs with the entire physical configuration rotated from world X to Z and translated", async () => {
  const f = warehouseFixture(1),
    c = compileSceneRuntime(f.bundle, f.bytes, f.goal, "validation");
  const q = new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 0),
      Math.PI / 2,
    ),
    offset = new Vector3(4, 0, -2);
  const point = (p: number[]) =>
      new Vector3(...p).applyQuaternion(q).add(offset).toArray(),
    direction = (p: number[]) => new Vector3(...p).applyQuaternion(q).toArray();
  for (const b of c.physics.bodies!) {
    b.position = point(b.position);
    b.rotation = q
      .clone()
      .multiply(new Quaternion(...b.rotation))
      .toArray();
  }
  for (const s of c.physics.surfaces!) {
    s.direction = direction(s.direction);
    s.normal = direction(s.normal);
  }
  for (const a of c.warehouse!.assemblies) {
    a.anchor = point(a.anchor);
    a.axis = direction(a.axis);
    a.vertical = direction(a.vertical);
  }
  for (const l of c.warehouse!.locations.values())
    l.position = point(l.position);
  for (const b of c.warehouse!.conveyors.values()) b.flow = direction(b.flow);
  const { program } = await assembleSceneRuntime("rotated", "rotated-run", c);
  program.start();
  let s = program.snapshot();
  for (let i = 0; i < 20000 && program.needsStep(); i++)
    s = program.step(1 / 60);
  expect(s.status, s.error).toBe("succeeded");
  program.dispose();
}, 30000);

it("checks the measured dock even when a legal numeric DSL target is changed", async () => {
  const f = warehouseFixture(1);
  (
    f.bundle.process.task.jobs as { in_slot_height: number }[]
  )[0].in_slot_height += 0.06;
  const compiled = compileSceneRuntime(f.bundle, f.bytes, f.goal, "validation");
  const { program } = await assembleSceneRuntime(
    "numeric",
    "numeric-run",
    compiled,
  );
  program.start();
  let state = program.snapshot();
  for (let i = 0; i < 15000 && program.needsStep(); i++)
    state = program.step(1 / 60);
  expect(state.error).toContain("aligned");
  const w = state.observations.samples["world/state"].value as {
    inventory: { events: unknown[] };
    mounts: Record<string, { held?: string }>;
  };
  expect(w.inventory.events).toHaveLength(0);
  expect(w.mounts.L1.held).toBe("M01");
  program.discard();
});
it("rejects detached and misaligned slide installations during preparation", () => {
  const f = warehouseFixture(1);
  const links = f.bundle.connections!;
  expect(links).toHaveLength(2);
  f.bundle.connections = links.slice(1);
  expect(() =>
    compileSceneRuntime(f.bundle, f.bytes, f.goal, "validation"),
  ).toThrow(/mounted lift/i);
  f.bundle.connections = links;
  const rail = f.bundle.devices.find((d) => d.instance_id === "T1")!;
  const port = (
    rail.contract.interfaces as {
      interface_id: string;
      local_frame: { position: number[] };
    }[]
  ).find((p) => p.interface_id === "carriage_mount")!;
  port.local_frame.position[1] += 0.1;
  expect(() =>
    compileSceneRuntime(f.bundle, f.bytes, f.goal, "validation"),
  ).toThrow(/not aligned/i);
});

it("accepts an archived rail/lift pair while giving an explicit disconnection precedence", () => {
  const f = warehouseFixture(1);
  const links = f.bundle.connections!;
  for (const { a, b } of links) {
    const rail = f.bundle.devices.find(d => d.instance_id === a.instanceId)!;
    const lift = f.bundle.devices.find(d => d.instance_id === b.instanceId)!;
    (rail.contract.type_specific_contract as Record<string,unknown>).mounted_device = b.instanceId;
    (lift.contract.type_specific_contract as Record<string,unknown>).mounted_on = a.instanceId;
  }
  delete f.bundle.connections;
  expect(compileSceneRuntime(f.bundle,f.bytes,f.goal,"validation").warehouse!.assemblies).toHaveLength(2);
  f.bundle.connections = [];
  expect(() => compileSceneRuntime(f.bundle,f.bytes,f.goal,"validation")).toThrow(/mounted lift/i);
});

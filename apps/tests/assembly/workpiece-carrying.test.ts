import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { getDeviceModule } from "../../src/devices/registry";
import {
  carryingProperties,
  normalizeSceneCarrying,
} from "../../src/devices/workpiece/behavior";
import { normalizeDeviceSpec } from "../../src/domain/normalizeDeviceSpec";
import { parseProject } from "../../src/validation/contracts";
import { createDemoProject } from "../../src/domain/catalog";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";
import { sceneFixture } from "./fixtures";
import type { PhysicsPort } from "../../src/contracts/physics";

describe("workpiece carrying profiles", () => {
  it("imports plain rigid bodies and restores legacy saved definitions without changing their IDs or source", () => {
    const plain = JSON.parse(
      readFileSync("public/modles/engine_block/schema.json", "utf8"),
    );
    expect(
      normalizeDeviceSpec(plain).typeSpecificContract.carrying,
    ).toBeUndefined();
    const legacy = JSON.parse(
      readFileSync("public/catalog/examples/carrier_tray_1.json", "utf8"),
    );
    const normalized = normalizeDeviceSpec(legacy);
    expect(normalized.deviceType).toBe("workpiece");
    expect(normalized.typeSpecificContract.carrying).toMatchObject({
      slots: [],
    });
    expect(normalized.source).toEqual(legacy);
    const project = createDemoProject();
    const old = project.definitions.find(
      (d) => d.specId === "template.workpiece_carrier",
    )!;
    old.deviceType = "workpiece_carrier";
    delete old.typeSpecificContract.carrying;
    const loaded = parseProject(project);
    const restored = loaded.definitions.find((d) => d.specId === old.specId)!;
    expect(restored.deviceType).toBe("workpiece");
    expect(restored.typeSpecificContract.carrying).toBeDefined();
    expect(loaded.instances).toEqual(project.instances);
    expect(parseProject(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded);
  });

  it.each([
    ["S01", 12],
    ["S02", 25],
    ["S06", 9],
  ] as const)(
    "uses the same measured carrier slots for legacy and canonical %s instances",
    (scene, count) => {
      const { bundle, bytes, goal } = sceneFixture(scene);
      const before = compileSceneRuntime(bundle, bytes, goal, "validation");
      const id = before.task.pallets[0].id;
      const d = before.devices.get(id)!;
      expect(d.contract.device_type).toBe("workpiece");
      const carrying = carryingProperties(d.contract)!;
      expect(carrying.slots).toHaveLength(count);
      expect(
        carrying.slots.every(
          (s) => s.position && s.frame === "carrier_local_m",
        ),
      ).toBe(true);
      for (const original of bundle.devices.filter(
        (d) => d.contract.device_type === "workpiece_carrier",
      )) {
        const c = before.devices.get(original.instance_id)!;
        original.contract = structuredClone(c.contract);
        // New type templates supply actual local coordinates directly.
        if (scene === "S06" && original.instance_id === id)
          original.locations = {};
      }
      const after = compileSceneRuntime(bundle, bytes, goal, "validation");
      expect(after.physics.carrierBindings).toEqual(
        before.physics.carrierBindings,
      );
      expect(after.bodyMap.get(id + "/body")).toEqual(
        before.bodyMap.get(id + "/body"),
      );
      expect(after.task.pallets).toEqual(before.task.pallets);
      expect(after.visualBodies.map((b) => b.instanceId)).toEqual(
        before.visualBodies.map((b) => b.instanceId),
      );
      for (const slot of Object.keys(d.locations))
        expect(after.devices.get(id)!.locations[slot].position).toEqual(
          d.locations[slot].position,
        );
      const wrong = after.devices.get(id)!;
      expect(() =>
        normalizeSceneCarrying({
          ...wrong,
          locations: {
            ...wrong.locations,
            [id + "." + carrying.slots[0].id]: {
              frame: "scene_world_m",
              position: [1, 2, 3],
            },
          },
        }),
      ).toThrow(/slot/);
    },
  );
  it("rejects ambiguous slot layouts and declared loads above the pallet rating", () => {
    const { bundle, bytes, goal } = sceneFixture("S06");
    const pallet = bundle.devices.find((d) => d.instance_id === "P01")!;
    const parameters = pallet.parameters as Record<string, unknown>;
    parameters.max_load_kg = 0.5;
    expect(() =>
      compileSceneRuntime(bundle, bytes, goal, "validation"),
    ).toThrow(/payload/);
    expect(() =>
      carryingProperties({
        device_type: "workpiece",
        type_specific_contract: {
          carrying: {
            slots: [{ id: "slot" }, { id: "slot" }],
          },
        },
      }),
    ).toThrow(/slot/i);
  });

  it("retains unresolved S10 slot identities without supplying fictitious coordinates", () => {
    const doc = JSON.parse(
      readFileSync("public/scene/S10/device/P01.json", "utf8"),
    );
    const contract = JSON.parse(
      readFileSync("public/scene/S10/contracts/workpiece_carrier.json", "utf8"),
    );
    const properties = carryingProperties(
      contract,
      doc.parameters,
      doc.locations,
    )!;
    expect(properties.slots.map((s) => s.id)).toEqual([
      "slot1",
      "slot2",
      "slot3",
      "slot4",
    ]);
    expect(properties.slots.every((s) => s.position === undefined)).toBe(true);
  });
  it("commits slot custody once per material and isolates reservations and physical supply by run", () => {
    const workpiece = getDeviceModule("workpiece");
    const a = workpiece.createInventory(["P1.a", "P1.b"]),
      b = workpiece.createInventory(["P1.a"]);
    a.reserve("P1.a", "M", "request");
    expect(() => a.load("P1.a", "M", "different")).toThrow();
    expect(() => a.reserve("P1.b", "M", "another")).toThrow();
    a.cancel("P1.a", "different");
    expect(() => a.load("P1.a", "M")).toThrow();
    a.cancel("P1.a", "request");
    a.load("P1.b", "M");
    expect(() => a.load("P1.a", "M")).toThrow();
    expect(() => a.unload("P1.b", "other")).toThrow();
    a.unload("P1.b", "M");
    expect(a.snapshot()).toEqual({});
    expect(b.snapshot()).toEqual({});
    const physical = { isBodyActive: () => false, activateBodies: vi.fn() };
    const source = getDeviceModule("material_source_station").createSupply(
      physical as unknown as PhysicsPort,
    );
    const batch = [
      {
        id: "M",
        pose: {
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          velocity: [0, 0, 0],
        },
      },
    ] as Parameters<typeof source.present>[0];
    source.present(batch);
    source.present(batch);
    expect(physical.activateBodies).toHaveBeenCalledTimes(1);
  });
});

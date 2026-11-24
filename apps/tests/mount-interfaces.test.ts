import { withModelMount } from "../src/domain/spatial/modelMount";
import type { DeviceDefinition } from "../src/contracts/device";
import { expect, it } from "vitest";
import type { SpatialConnection } from "../src/contracts/device";
import type { SpatialInterface } from "../src/contracts/spatial";
import { mountParents } from "../src/domain/spatial/mounts";

const link = (child: string, parent: string): SpatialConnection => ({
  id: parent + "/" + child,
  a: { instanceId: child, interfaceId: "foot" },
  b: { instanceId: parent, interfaceId: "slide" },
});
const at = (end: SpatialConnection["a"]): SpatialInterface => {
  const base = end.interfaceId === "foot";
  return {
    interface_id: end.interfaceId,
    name: end.interfaceId,
    local_frame: {
      position: [0, 0, 0],
      forward: [0, base ? -1 : 1, 0],
      up: [0, 0, 1],
    },
    capabilities: {
      snap: {
        role: base ? "mount_base" : "carriage_mount",
        accepts: [base ? "carriage_mount" : "mount_base"],
      },
    },
  };
};
it("resolves renamed, reversed and nested installation endpoints and rejects invalid graphs", () => {
  const roots = mountParents([link("part", "lift"), link("lift", "slide")], at);
  expect(roots.get("part")?.instanceId).toBe("lift");
  expect(roots.get("lift")?.instanceId).toBe("slide");
  expect(() =>
    mountParents([link("lift", "slide"), link("slide", "lift")], at),
  ).toThrow(/cyclic/i);
  expect(() =>
    mountParents([link("a", "slide"), link("b", "slide")], at),
  ).toThrow(/occupied/i);
  expect(() =>
    mountParents([link("a", "slide"), link("a", "other")], at),
  ).toThrow(/occupied/i);
  expect(() =>
    mountParents([link("a", "slide")], (e) => ({
      ...at(e),
      local_frame: undefined,
      local_frame_pending: true,
    })),
  ).toThrow(/uncalibrated/i);
});

it("recomputes a re-associated model's bottom away from its pivot, including import transform", () => {
  const layout = {
    scenes: [{ nodes: [0] }],
    nodes: [
      { translation: [2, 1, 3], children: [1] },
      { translation: [0, 4, 0], mesh: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min: [-1, -1, -1], max: [1, 1, 1] }],
  };
  const raw = new TextEncoder().encode(JSON.stringify(layout));
  const bytes = new ArrayBuffer(20 + raw.length);
  new DataView(bytes).setUint32(12, raw.length, true);
  new Uint8Array(bytes, 20).set(raw);
  const def = {
    asset: {
      importTransform: {
        position: [4, 0, 7],
        rotation: [0, 0, Math.PI / 2],
        scale: [2, 2, 2],
      },
    },
  } as DeviceDefinition;
  const port = withModelMount(def, bytes).spatialInterfaces![0];
  const position = port.local_frame!.position;
  expect(position[0]).toBeCloseTo(1);
  expect(position[1]).toBeCloseTo(5);
  expect(position[2]).toBeCloseTo(3);
  expect(port.local_frame!.forward[0]).toBeCloseTo(-1);
});

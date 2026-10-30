import { describe, it, expect } from "vitest";
import { Matrix4, Euler, Quaternion, Vector3 } from "three";
import { readFileSync } from "node:fs";
import { normalizeDeviceSpec } from "../src/domain/normalizeDeviceSpec";
import { resolveInterfaceFrame } from "../src/domain/resolveInterfaceFrame";
import { resolveParameters, parseProject } from "../src/validation/contracts";
import { createDemoProject } from "../src/domain/catalog";
const def = normalizeDeviceSpec(
  JSON.parse(readFileSync("public/modles/Conveyor_aankws/schema.json", "utf8")),
);
describe("interface model coordinates", () => {
  it("uses authored endpoint coordinates and transforms them exactly once", () => {
    const f = resolveInterfaceFrame(
      def.spatialInterfaces![0],
      def,
      resolveParameters(def, {}),
    )!;
    expect(f.position).toEqual([-0.749, 0.7, 0]);
    const importMatrix = new Matrix4().compose(
      new Vector3(1, 0, 0),
      new Quaternion(),
      new Vector3(1, 1, 1),
    );
    const instanceMatrix = new Matrix4().compose(
      new Vector3(3, 0, 2),
      new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0)),
      new Vector3(2, 2, 2),
    );
    const p = new Vector3(...f.position)
      .applyMatrix4(importMatrix)
      .applyMatrix4(instanceMatrix);
    expect(p.x).toBeCloseTo(3);
    expect(p.y).toBeCloseTo(1.4);
    expect(p.z).toBeCloseTo(1.498);
  });
  it("leaves pending interfaces unresolved and evaluates only the supported rule", () => {
    const port = def.spatialInterfaces![0];
    expect(
      resolveInterfaceFrame(
        { ...port, local_frame: undefined, local_frame_pending: true },
        def,
        {},
      ),
    ).toBeNull();
    const rule = {
      ...port,
      local_frame: undefined,
      local_frame_rule: {
        origin_ref: "type_specific_contract.conveyor_geometry.surface_center",
        offset_axis: [1, 0, 0] as [number, number, number],
        offset_param: "length_m",
        offset_factor: 0.5,
        height_param: "surface_height_m",
        forward: [1, 0, 0] as [number, number, number],
        up: [0, 1, 0] as [number, number, number],
      },
    };
    expect(
      resolveInterfaceFrame(rule, def, resolveParameters(def, {}))?.position[0],
    ).toBeCloseTo(0.7005);
    expect(() => resolveInterfaceFrame(rule, def, {})).toThrow();
  });
  it("retains public asset identity and import transform through project save", () => {
    const p = createDemoProject();
    p.definitions.push({
      ...def,
      asset: { ...def.asset, sha256: "test", sourceUrl: "/modles/test.glb" },
    });
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
});

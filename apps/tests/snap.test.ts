import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeDeviceSpec } from "../src/domain/normalizeDeviceSpec";
import { findSnap, interfaceWorld } from "../src/domain/spatial/snap";
import { commitTransform } from "../src/editor/transformActions";
import { useWorkspace } from "../src/stores/workspace";
import { parseProject } from "../src/validation/contracts";
import type { DeviceInstance, ProjectDocument } from "../src/contracts/device";
const def = normalizeDeviceSpec(
  JSON.parse(readFileSync("public/modles/Conveyor_aankws/schema.json", "utf8")),
);
function setup() {
  const a: DeviceInstance = {
    instanceId: "a",
    specId: def.specId,
    specRevision: def.revision,
    name: "A",
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    paramOverrides: {},
    bindings: {},
  };
  const b = structuredClone(a);
  b.instanceId = "b";
  b.transform.position = [1.55, 0, 0];
  const p: ProjectDocument = {
    format: "agentic-workbench",
    version: 1,
    id: "snap",
    name: "snap",
    revision: 0,
    definitions: [structuredClone(def)],
    instances: [a, b],
    assets: [],
    plc: "",
  };
  return { a, b, p };
}
describe("spatial interface snapping", () => {
  it("solves endpoint positions and opposing orientations", () => {
    const { a, b, p } = setup();
    const c = findSnap(p, a)!;
    expect(c.sourceInterface).toBe("end_positive_x");
    expect(c.targetInterface).toBe("end_negative_x");
    expect(c.transform.position[0]).toBeCloseTo(0.05);
    const source = interfaceWorld(
      { ...a, transform: c.transform },
      def,
      c.sourceInterface,
    )!;
    const target = interfaceWorld(b, def, c.targetInterface)!;
    expect(source.position.distanceTo(target.position)).toBeLessThan(1e-6);
  });
  it("includes model import transforms and rotation in the solution", () => {
    const { a, b, p } = setup();
    p.definitions[0].asset.importTransform = {
      position: [0.2, 0.1, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
    a.transform.rotation = [0, Math.PI / 2 - 0.04, 0];
    b.transform.rotation = [0, Math.PI / 2, 0];
    b.transform.position = [0, 0, -1.55];
    const c = findSnap(p, a)!;
    expect(c).not.toBeNull();
    const d = p.definitions[0];
    expect(
      interfaceWorld(
        { ...a, transform: c.transform },
        d,
        c.sourceInterface,
      )!.position.distanceTo(interfaceWorld(b, d, c.targetInterface)!.position),
    ).toBeLessThan(1e-6);
  });
  it.each([
    "far",
    "incompatible",
    "pending",
    "hidden",
    "scale",
    "occupied",
    "wrong_orientation",
  ])("rejects %s", (reason) => {
    const { a, b, p } = setup();
    if (reason === "far") b.transform.position = [10, 0, 0];
    if (reason === "incompatible")
      p.definitions[0].spatialInterfaces!.forEach(
        (i) => (i.capabilities.snap.accepts = ["other"]),
      );
    if (reason === "pending")
      p.definitions[0].spatialInterfaces!.forEach((i) => {
        delete i.local_frame;
        i.local_frame_pending = true;
      });
    if (reason === "hidden") b.visible = false;
    if (reason === "scale") a.transform.scale = [2, 1, 1];
    if (reason === "occupied")
      p.connections = [
        {
          id: "used",
          a: { instanceId: "b", interfaceId: "end_negative_x" },
          b: { instanceId: "c", interfaceId: "end_positive_x" },
        },
      ];
    if (reason === "wrong_orientation") {
      b.transform.position = [0, 0, 0];
    }
    expect(findSnap(p, a)).toBeNull();
  });
  it("commits once, persists the connection and invalidates it when moved", () => {
    const { a, p } = setup();
    useWorkspace.getState().initialize(p);
    const candidate = findSnap(p, a)!;
    expect(commitTransform(p, "a", candidate.transform, candidate)).toBe(true);
    const changed = useWorkspace.getState().project!;
    expect(changed.revision).toBe(1);
    expect(
      parseProject(JSON.parse(JSON.stringify(changed))).connections,
    ).toHaveLength(1);
    expect(commitTransform(p, "a", a.transform, null)).toBe(false);
    useWorkspace.getState().updateInstance("a", { transform: a.transform });
    expect(useWorkspace.getState().project!.connections).toHaveLength(0);
  });
  it("refuses edits during preview lock", () => {
    const { a, p } = setup();
    useWorkspace.getState().initialize(p);
    useWorkspace.setState({ documentLocked: true });
    expect(commitTransform(p, "a", a.transform, null)).toBe(false);
    expect(useWorkspace.getState().project).toBe(p);
    useWorkspace.setState({ documentLocked: false });
  });
});

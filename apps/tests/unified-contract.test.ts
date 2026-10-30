import { describe, it, expect } from "vitest";
import { createDemoProject } from "../src/domain/catalog";
import { readFileSync } from "node:fs";
import { normalizeDeviceSpec } from "../src/domain/normalizeDeviceSpec";
import {
  definitionSchema,
  semanticIssues,
  parseProject,
} from "../src/validation/contracts";
const read = () =>
  JSON.parse(
    readFileSync("../test1/modles/Conveyor_aankws/schema.json", "utf8"),
  );
describe("unified device contract", () => {
  it("preserves capabilities and behavior contracts across serialization", () => {
    const def = normalizeDeviceSpec(read());
    expect(def.spatialInterfaces).toHaveLength(2);
    for (const endpoint of def.spatialInterfaces ?? []) {
      expect(endpoint.local_frame_pending).toBeUndefined();
      expect(endpoint.local_frame).toBeDefined();
      expect(endpoint.local_frame_rule).toBeUndefined();
      expect(
        (endpoint.capabilities as Record<string, unknown>).process,
      ).toBeUndefined();
      expect("signal_refs" in endpoint).toBe(false);
    }
    expect(Object.keys(def.paramsSchema)).toHaveLength(14);
    expect(def.interfaces.find((p) => p.id === "runTag")?.valueType).toBe(
      "BOOL",
    );
    expect(
      def.behaviors.find((b) => b.id === "publish_drive_feedback")?.kind,
    ).toBe("observer");
    expect(def.behaviors.find((b) => b.id === "transport_to_exit")?.kind).toBe(
      "composite",
    );
    expect(def.behaviors[0].kind).toBe("service");
    expect(def.behaviors[0].executorRef).toBe("agent.conveyor.accept_material");
    expect(def.behaviors[0].completionChecks.length).toBeGreaterThan(0);
    expect(definitionSchema.parse(JSON.parse(JSON.stringify(def)))).toEqual(
      def,
    );
    expect(semanticIssues(def)).toEqual([]);
    const project = createDemoProject();
    project.definitions = [def];
    project.instances = [];
    expect(parseProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
  });
  it.each([
    "signal",
    "behavior",
    "duplicate",
    "frame",
    "axis",
    "parameter",
    "condition",
    "direction",
    "type",
    "old_fields",
    "version",
    "no_frame",
    "surface",
    "region",
    "registry",
    "node",
    "drive",
    "bound_signal",
    "interpolation",
  ])("rejects %s", (kind) => {
    const r = read(),
      i = r.interfaces[0];
    if (kind === "signal") i.signal_refs = ["runTag"];
    if (kind === "behavior")
      i.capabilities.process = {
        role: "material_transfer",
        direction: "input",
        accepted_material_types: ["workpiece"],
        behavior_refs: ["absent"],
      };
    if (kind === "duplicate") r.interfaces.push(r.interfaces[0]);
    if (kind === "frame") {
      i.local_frame_pending = true;
      i.local_frame = {
        position: [0, 0, 0],
        forward: [1, 0, 0],
        up: [0, 1, 0],
      };
    }
    if (kind === "axis" || kind === "parameter") {
      delete i.local_frame;
      delete i.local_frame_pending;
      i.local_frame_rule = {
        origin_ref: "type_specific_contract.conveyor_geometry.surface_center",
        offset_axis: [1, 0, 0],
        offset_param: kind === "parameter" ? "absent" : "length_m",
        offset_factor: 0.5,
        height_param: "surface_height_m",
        forward: [1, 0, 0],
        up: kind === "axis" ? [1, 0, 0] : [0, 1, 0],
      };
    }

    if (kind === "condition")
      r.transport_behaviors[0].condition_contract.preconditions[0].key =
        "absent";
    if (kind === "direction")
      r.transport_behaviors[0].input_signals.push("done");
    if (kind === "type") r.signal_ports[0].plc_type = "REAL";
    if (kind === "old_fields") r.process_ports = [];
    if (kind === "surface")
      r.type_specific_contract.conveying_surface.normal = [1, 0, 0];
    if (kind === "region")
      r.type_specific_contract.observation_regions[0].surface_ref = "absent";
    if (kind === "registry")
      r.runtime_execution_contract.signal_management.spatial_binding = true;
    if (kind === "node")
      r.type_specific_contract.conveying_surface.node_binding_role = "absent";
    if (kind === "drive")
      r.type_specific_contract.conveying_surface.drive.speed_signal = "done";
    if (kind === "bound_signal")
      r.signal_ports[0].bound_to = { id: "end_negative_x" };
    if (kind === "interpolation")
      r.type_specific_contract.conveying_surface.material_motion =
        "endpoint_interpolation";
    if (kind === "no_frame") delete i.local_frame;
    if (kind === "version") r.contract_version = "999";
    expect(() => normalizeDeviceSpec(r)).toThrow();
  });
});

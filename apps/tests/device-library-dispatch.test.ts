import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import catalog from "@/devices/catalog.json";
import { getDeviceModule, resolveDeviceAction } from "@/devices/registry";

function read(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

it("dispatches every schedulable device-library action in all published model and scene profiles", () => {
  for (const [file, variant] of Object.entries(catalog.publications)) {
    const spec = read("public/" + file);
    const profile = catalog.profiles[variant as keyof typeof catalog.profiles];
    for (const action of spec.transport_behaviors) {
      if (!action.schedulable || spec.device_type === "workpiece_carrier")
        continue;
      const context = file + "#" + action.behavior_id;
      expect(resolveDeviceAction(spec, action.behavior_id), context).toBe(
        getDeviceModule(profile.type),
      );
    }
  }
});

it("rejects mixed model capabilities, wrong units, misdirected ports and unknown revisions", () => {
  const conveyor = () => read("public/scene/S01/contracts/conveyor.json");
  let c = conveyor();
  c.transport_behaviors.find(
    (x: { behavior_id: string }) => x.behavior_id === "transport_to_position",
  ).input_signals = ["reset"];
  expect(() => resolveDeviceAction(c, "transport_to_position")).toThrow(
    /signature/,
  );
  c = conveyor();
  c.transport_behaviors.find(
    (x: { behavior_id: string }) => x.behavior_id === "transport_to_position",
  ).arguments_schema.subject_id.type = "number";
  expect(() => resolveDeviceAction(c, "transport_to_position")).toThrow(
    /signature/,
  );
  c = conveyor();
  c.signal_ports.find(
    (p: { port_id: string }) => p.port_id === "actual_speed",
  ).unit = "fpm";
  expect(() => resolveDeviceAction(c, "stop_conveying")).toThrow(/signature/);
  c = conveyor();
  c.signal_ports.find(
    (p: { port_id: string }) => p.port_id === "actual_speed",
  ).direction = "input";
  expect(() => resolveDeviceAction(c, "stop_conveying")).toThrow(/方向/);
  c = conveyor();
  c.runtime_contract.condition_model.expressions[
    "transport_to_position.ready"
  ].expr = {
    op: "literal",
    value: true,
    unit: "1",
  };
  expect(() => resolveDeviceAction(c, "transport_to_position")).toThrow(
    /signature/,
  );
  c = conveyor();
  c.version = "missing";
  expect(() => resolveDeviceAction(c, "stop_conveying")).toThrow(/profile/);
  const robot = read("public/scene/S04/contracts/robot_arm.json");
  expect(() => resolveDeviceAction(robot, "process_material")).toThrow(
    /executor/,
  );
  const other = read("public/scene/S11/contracts/robot_arm.json");
  expect(other.version).toBe(robot.version);
  robot.transport_behaviors.push(
    other.transport_behaviors.find(
      (b: { behavior_id: string }) => b.behavior_id === "process_material",
    ),
  );
  expect(() => resolveDeviceAction(robot, "process_material")).toThrow();
});

it("accepts a distinct model selecting a compatible subset and rejects an unregistered command shape", () => {
  const raw = read("public/modles/Conveyor_aankws/schema.json");
  raw.schema_id = raw.device_spec_id = "custom-conveyor";
  raw.transport_behaviors = raw.transport_behaviors.filter(
    (b: { behavior_id: string }) => b.behavior_id === "transport_to_exit",
  );
  expect(resolveDeviceAction(raw, "transport_to_exit")).toBe(
    getDeviceModule("conveyor"),
  );
  raw.transport_behaviors[0].completion_contract.checks = [];
  expect(() => resolveDeviceAction(raw, "transport_to_exit")).toThrow(
    /signature/,
  );
});

it("retains the required pick/place ABI and rejects an incompatible optional grip field", () => {
  const spec = read("public/scene/S06/contracts/robot_arm.json");
  const payload =
    spec.runtime_execution_contract.payload_templates.pick_and_place;
  expect(payload.optional_fields).toEqual({ grasp: "grasp_frame_ref" });
  payload.optional_fields.grasp = "location_ref";
  expect(() => resolveDeviceAction(spec, "pick_and_place")).toThrow(
    /signature/,
  );
  delete payload.optional_fields;
  expect(resolveDeviceAction(spec, "pick_and_place").type).toBe("robot_arm");
});

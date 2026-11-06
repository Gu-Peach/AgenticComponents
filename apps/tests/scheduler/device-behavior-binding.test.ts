import { it, expect } from "vitest";
import {
  bindDeviceBehavior,
  signalLayoutFromContract,
} from "../../src/domain/runtime/bindDeviceBehavior";
const contract = {
  schema_type: "DeviceSpec",
  version: "1",
  params_schema: { enabled: { default: true }, mode: { default: "distance" } },
  signal_ports: [
    { port_id: "target", direction: "input", plc_type: "REAL", unit: "m" },
    {
      port_id: "position",
      direction: "output",
      plc_type: "REAL",
      unit: "m",
      retention: "sampled_state",
    },
  ],
  transport_behaviors: [
    {
      behavior_id: "move",
      behavior_type: "action",
      schedulable: true,
      arguments_schema: {
        distance: { type: "number", required: true, unit: "m", min: 0, max: 5 },
      },
      input_signals: ["target"],
      output_signals: ["position"],
      condition_contract: {
        preconditions: [
          { key: "ready", source: "observation" },
          { key: "authorized", source: "authorization" },
        ],
        sustaining_conditions: [],
      },
      completion_contract: {
        mode: "observed",
        checks: [{ key: "positioned", source: "observation" }],
      },
      applicability: { conditions: [{ parameter: "enabled", equals: true }] },
    },
  ],
  runtime_execution_contract: {
    argument_variants: {
      move: {
        selector_parameter: "mode",
        variants: {
          distance: { required: ["distance"], forbidden: ["angle"] },
        },
      },
    },
  },
};
const implementation = {
  contractVersion: "1",
  resources: () => [],
  stopped: ["D/stopped"],
  validatePayload: () => {},
};
it("binds actual condition keys and separates resource authorization from readiness", () => {
  const bound = bindDeviceBehavior("D", contract, "move", implementation);
  expect(bound.preconditions).toEqual(["D/ready"]);
  expect(bound.authorization).toEqual(["D/authorized"]);
  expect(bound.completion).toEqual(["D/positioned"]);
  bound.validateArguments({ distance: { value: 2, unit: "m" } }, undefined);
  expect(() =>
    bound.validateArguments({ distance: { value: 2, unit: "s" } }, undefined),
  ).toThrow("unit");
  expect(() =>
    bound.validateArguments({ distance: { value: 20, unit: "m" } }, undefined),
  ).toThrow("outside");
  expect(() => bound.validateArguments({}, undefined)).toThrow();
});
it("rejects missing behavior, adapter version drift, and disabled optional capability", () => {
  expect(() =>
    bindDeviceBehavior("D", contract, "invented", implementation),
  ).toThrow();
  expect(() =>
    bindDeviceBehavior("D", contract, "move", {
      ...implementation,
      contractVersion: "old",
    }),
  ).toThrow();
  expect(() =>
    bindDeviceBehavior("D", contract, "move", {
      ...implementation,
      parameters: { enabled: false },
    }),
  ).toThrow("applicable");
});
it("constructs isolated signal namespaces and explicit sample freshness", () => {
  const layout = signalLayoutFromContract("scene-a", "D", contract);
  expect(layout[0].key).toBe("scene-a/D/target");
  expect(layout[0].writer).toBe("process");
  expect(layout[1].writer).toBe("adapter:D");
  expect(layout[1].maxAgeTicks).toBe(2);
});

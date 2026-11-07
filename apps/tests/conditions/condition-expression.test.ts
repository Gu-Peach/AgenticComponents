import { describe, it, expect } from "vitest";
import { evaluateCondition } from "../../src/runtime/signals/ConditionEvaluator";
import { ConditionTrace } from "../../src/runtime/signals/ConditionTrace";
import { compileConditions } from "../../src/domain/runtime/compileConditions";
import { conditionDecisionFor } from "../../src/domain/runtime/conditionDecisionFor";
import { sceneFixture } from "../assembly/fixtures";
import type {
  CompiledCondition,
  ConditionExpr,
  ConditionDecision,
} from "../../src/contracts/condition-expression";
import type { ConditionContext } from "../../src/contracts/conditions";
const context: ConditionContext = {
  frame: { runId: "run", tick: 10, revision: 1, samples: {} },
  tick: 11,
  scope: {},
  owns: () => false,
  nodeId: "pick",
  activationId: "iteration-1",
  phase: "precondition",
};
const ref = (binding: string): ConditionExpr => ({ op: "ref", binding });
function compile(expr: ConditionExpr): CompiledCondition {
  return {
    key: "R/ready",
    device: "R",
    behavior: "pick",
    phase: "precondition",
    expected: true,
    expr,
    bindings: Object.fromEntries(
      ["a", "b"].map((name) => [
        name,
        {
          kind: "parameter",
          parameter: name,
          behavior: "pick",
          value_type: "boolean",
          unit: "1",
        },
      ]),
    ),
  };
}
function evaluate(expr: ConditionExpr, a: boolean | null, b: boolean | null) {
  return evaluateCondition(compile(expr), context, (binding) => ({
    value: binding.kind === "parameter" && binding.parameter === "a" ? a : b,
    quality:
      (binding.kind === "parameter" && binding.parameter === "a" ? a : b) ===
      null
        ? "unknown"
        : "good",
    sampledTick: 9,
    source: "fixture",
  }));
}
describe("three-valued conditions", () => {
  for (const a of [true, false, null])
    for (const b of [true, false, null])
      for (const op of ["all", "any"] as const)
        it(`${op} ${a} ${b}`, () => {
          const expected =
            op === "all"
              ? a === false || b === false
                ? false
                : a === null || b === null
                  ? null
                  : true
              : a === true || b === true
                ? true
                : a === null || b === null
                  ? null
                  : false;
          const result = evaluate({ op, args: [ref("a"), ref("b")] }, a, b);
          expect(result.value).toBe(expected);
          expect(result.nodes).toHaveLength(3);
          expect(result.inputSampleTick).toBe(10);
          expect(result.evaluatedTick).toBe(11);
        });
  it("does not turn unknown or invalid into TRUE through negation", () => {
    expect(
      evaluate({ op: "not", arg: ref("a") }, null, false).value,
    ).toBeNull();
    const result = evaluateCondition(
      compile({ op: "not", arg: ref("a") }),
      context,
      () => ({
        value: false,
        quality: "disconnected",
        sampledTick: 9,
        source: "sensor",
      }),
    );
    expect(result.value).toBeNull();
    expect(result.quality).toBe("disconnected");
  });
  it("reads a reused binding once and retains unknown siblings behind a decisive branch", () => {
    let reads = 0;
    const result = evaluateCondition(
      compile({ op: "any", args: [ref("a"), ref("a"), ref("b")] }),
      context,
      (b) => {
        reads++;
        return {
          value: b.kind === "parameter" && b.parameter === "a" ? true : null,
          quality:
            b.kind === "parameter" && b.parameter === "a" ? "good" : "unknown",
          sampledTick: 10,
          source: "input",
        };
      },
    );
    expect(reads).toBe(2);
    expect(result.value).toBe(true);
    expect(result.nodes.some((n) => n.quality === "unknown")).toBe(true);
  });
});
describe("declaration refusal", () => {
  const fixture = sceneFixture();
  const original = fixture.bundle.devices.find(
    (d) => d.instance_id === "R1",
  )!.contract;
  it("resolves the real structured contract", () =>
    expect(compileConditions("R1", original, "pick_and_place")).toHaveLength(
      3,
    ));
  for (const mutation of [
    "unknown_port",
    "unit",
    "done_cycle",
    "self_trigger",
    "version",
    "depth",
    "scope",
  ] as const)
    it(`rejects ${mutation}`, () => {
      const raw = structuredClone(original) as typeof original & {
        runtime_contract: {
          condition_model: {
            schema_version: string;
            bindings: Record<string, Record<string, unknown>>;
            expressions: Record<string, { expr: ConditionExpr }>;
          };
        };
      };
      const m = raw.runtime_contract.condition_model;
      if (mutation === "unknown_port")
        m.bindings["pick_and_place.busy_run"].port = "invented";
      if (mutation === "unit") m.bindings["pick_and_place.busy_run"].unit = "m";
      if (mutation === "version") m.schema_version = "unknown";
      if (mutation === "scope")
        m.bindings["pick_and_place.matching_success"].scope = "run";
      if (mutation === "done_cycle") {
        m.bindings["pick_and_place.holding_material_request_subject"].port =
          "done";
      }
      if (mutation === "self_trigger")
        m.bindings["pick_and_place.busy_run"].port = "start_pick";
      if (mutation === "depth") {
        let expr: ConditionExpr = { op: "literal", value: true, unit: "1" };
        for (let i = 0; i < 50; i++) expr = { op: "not", arg: expr };
        m.expressions["pick_and_place.pre_1"].expr = expr;
      }
      expect(() => compileConditions("R1", raw, "pick_and_place")).toThrow();
    });
});
it("bounds transition history, records comparison differences and isolates loop activations and runs", () => {
  const trace = new ConditionTrace("compare", 2),
    base = evaluate(ref("a"), true, false);
  for (let tick = 1; tick < 5; tick++)
    trace.record({
      ...base,
      evaluatedTick: tick,
      value: tick % 2 === 0,
      legacyValue: true,
    });
  const snapshot = trace.snapshot();
  expect(snapshot.dropped).toBe(2);
  expect(snapshot.comparisons).toBe(4);
  expect(snapshot.mismatches).toBe(2);
  expect(
    conditionDecisionFor(
      snapshot,
      "pick",
      "precondition",
      "R/ready",
      "iteration-2",
    ),
  ).toBeUndefined();
  expect(
    conditionDecisionFor(
      snapshot,
      "pick",
      "precondition",
      "R/ready",
      "iteration-1",
    ),
  ).toBeDefined();
  expect(() => trace.record({ ...base, runId: "other" })).toThrow(
    /run mismatch/,
  );
  expect(new ConditionTrace().snapshot().latest).toEqual({});
  expect(() => {
    (snapshot.events[0] as ConditionDecision).value = false;
  }).toThrow();
});

import { describe, expect, it } from "vitest";
import {
  bindFactRoles,
  compileSignalConnections,
  connectedFactsHold,
  type FactReceipt,
  type StepFacts,
} from "@/domain/runtime/compileSignalConnections";
import type { ProcessNode } from "@/contracts/process-ir";
import type { ConditionContext } from "@/contracts/conditions";

const support = {
  semantic: "supported_at",
  subject: "part",
  endpoint: "belt.exit",
} as const;
const invoke = (id: string): ProcessNode => ({
  kind: "invoke",
  id,
  behavior: "move",
  device: { kind: "ref", name: "actor" },
  arguments: {},
});
const send: StepFacts = { provides: [support], requires: [] },
  receive: StepFacts = { requires: [support], provides: [] };
const steps = new Map([
  ["arrive", send],
  ["other", send],
  ["grip", receive],
]);
const seq = (...children: ProcessNode[]): ProcessNode => ({
  kind: "seq",
  id: "sequence",
  children,
});
const request = { requestId: "1", activationId: "batch/iteration-2/arrive" };
const context: ConditionContext = {
  scope: {},
  frame: { runId: "live", revision: 0, tick: 12, samples: {} },
  tick: 12,
  owns: () => false,
};
const receipt: FactReceipt = {
  ...request,
  runId: "live",
  producer: "arrive",
  fact: support,
};
describe("semantic workcell connections", () => {
  it("requires a causally prior result in addition to matching live physics", () => {
    const wires = compileSignalConnections(
      seq(invoke("arrive"), invoke("grip")),
      steps,
    );
    const read = (r: FactReceipt, current: boolean | undefined) =>
      connectedFactsHold(
        wires,
        "grip",
        context,
        [r],
        () => current,
        () => request,
      );
    expect(read(receipt, true)).toBe(true);
    expect(read(receipt, false)).toBe(false);
    expect(read(receipt, undefined)).toBeUndefined();
    expect(read({ ...receipt, runId: "previous" }, true)).toBe(false);
    expect(
      read({ ...receipt, activationId: "batch/iteration-1/arrive" }, true),
    ).toBe(false);
    expect(
      read({ ...receipt, fact: { ...support, subject: "other" } }, true),
    ).toBe(false);
    expect(
      read({ ...receipt, fact: { ...support, endpoint: "wrong" } }, true),
    ).toBe(false);
  });
  it("initial observations can start a process and cannot be supplied by a later or parallel sibling", () => {
    expect(
      compileSignalConnections(invoke("grip"), steps, [support])[0].producer,
    ).toBeNull();
    expect(() =>
      compileSignalConnections(seq(invoke("grip"), invoke("arrive")), steps),
    ).toThrow(/生产者/);
    expect(() =>
      compileSignalConnections(
        {
          kind: "par",
          id: "together",
          join: "all",
          children: [invoke("arrive"), invoke("grip")],
        },
        steps,
      ),
    ).toThrow(/生产者/);
  });
  it("rejects ambiguous join results, unknown role bindings and incompatible signal types", () => {
    const parallel: ProcessNode = {
      kind: "par",
      id: "together",
      join: "all",
      children: [invoke("arrive"), invoke("other")],
    };
    expect(() =>
      compileSignalConnections(seq(parallel, invoke("grip")), steps),
    ).toThrow(/多个生产者/);
    expect(() => bindFactRoles(send, {})).toThrow(/角色/);
    expect(() =>
      bindFactRoles(
        { requires: [], provides: [{ ...support, unit: "m" }] },
        { part: "part", "belt.exit": "belt.exit" },
      ),
    ).toThrow();
  });
  it("accepts the successful branch only and requires an initial observation for a zero-iteration producer", () => {
    const branch: ProcessNode = {
      kind: "branch",
      id: "choose",
      mode: "exclusive",
      timeout: { kind: "literal", value: 1 },
      cases: [
        { condition: { kind: "literal", value: true }, body: invoke("arrive") },
      ],
      otherwise: invoke("other"),
    };
    const wires = compileSignalConnections(seq(branch, invoke("grip")), steps);
    expect(wires[0].alternatives).toEqual(["other"]);
    expect(
      connectedFactsHold(
        wires,
        "grip",
        context,
        [receipt],
        () => true,
        (id) => (id === "arrive" ? request : undefined),
      ),
    ).toBe(true);
    expect(
      connectedFactsHold(
        wires,
        "grip",
        context,
        [receipt],
        () => true,
        (id) => (id === "other" ? request : undefined),
      ),
    ).toBe(false);
    const repeat: ProcessNode = {
      kind: "repeat",
      id: "maybe",
      count: { kind: "literal", value: 0 },
      body: invoke("arrive"),
    };
    expect(() =>
      compileSignalConnections(seq(repeat, invoke("grip")), steps),
    ).toThrow(/生产者/);
  });
  it("reads the newer writer when an exclusive branch replaces a previous result", () => {
    const branch: ProcessNode = {
      kind: "branch",
      id: "choose",
      mode: "exclusive",
      timeout: { kind: "literal", value: 1 },
      cases: [
        { condition: { kind: "literal", value: true }, body: invoke("other") },
      ],
      otherwise: {
        kind: "delay",
        id: "keep",
        duration: { kind: "literal", value: 1 },
      },
    };
    const edges = compileSignalConnections(
      seq(invoke("arrive"), branch, invoke("grip")),
      steps,
    );
    const newer = {
      ...receipt,
      producer: "other",
      activationId: "live/other/3",
      requestId: "2",
    };
    const sender = (id: string) => (id === "other" ? newer : request);
    expect(
      connectedFactsHold(edges, "grip", context, [receipt], () => true, sender),
    ).toBe(false);
    expect(
      connectedFactsHold(
        edges,
        "grip",
        context,
        [receipt, newer],
        () => true,
        sender,
      ),
    ).toBe(true);
  });
});

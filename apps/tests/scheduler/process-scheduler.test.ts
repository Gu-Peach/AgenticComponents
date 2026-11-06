import { describe, it, expect } from "vitest";
import { bindProcess } from "../../src/domain/runtime/bindProcess";
import {
  ProcessScheduler,
  ResourceArbiter,
  UNKNOWN,
} from "../../src/runtime/scheduler";
import { ConditionProviders } from "../../src/runtime/signals";
import type {
  ActionBinding,
  ActionFeedback,
  ActionEffect,
} from "../../src/contracts/scheduler";
import type { ProcessNode, Expression } from "../../src/contracts/process-ir";
const literal = (value: number | boolean | string): Expression => ({
  kind: "literal",
  value,
});
const seconds = (value: number): Expression => ({
  kind: "seconds",
  args: [literal(value)],
  kwargs: {},
});
const invoke = (id: string, device = "R1"): ProcessNode => ({
  id,
  kind: "invoke",
  device: { kind: "ref", name: device },
  behavior: "move",
  arguments: {},
});
function fixture(root: ProcessNode, overrides: Partial<ActionBinding> = {}) {
  const facts: Record<string, boolean | undefined> = {
    ready: true,
    alive: true,
    complete: true,
    stopped: true,
    goal: true,
  };
  const conditions = new ConditionProviders();
  for (const id of Object.keys(facts))
    conditions.register(id, { evaluate: () => facts[id] });
  const b: ActionBinding = {
    device: "R1",
    behavior: "move",
    preconditions: ["ready"],
    authorization: [],
    sustaining: ["alive"],
    completion: ["complete"],
    release: [],
    stopped: ["stopped"],
    resources: () => [],
    validateArguments: () => {},
    ...overrides,
  };
  const process = bindProcess(root, {
    scope: { R1: "R1", R2: "R2" },
    actions: [b, { ...b, device: "R2" }],
    providers: conditions,
    finalization: ["goal"],
    deadlines: {
      preconditions: 4,
      acceptance: 4,
      execution: 6,
      stop: 3,
      collection: 4,
      finalization: 4,
    },
  });
  const scheduler = new ProcessScheduler("run", process);
  let tick = 0;
  return {
    scheduler,
    conditions,
    process,
    facts,
    advance: (feedback: ActionFeedback[] = []) =>
      scheduler.advance({
        frame: { runId: "run", tick: tick++, revision: 0, samples: {} },
        feedback,
      }),
  };
}
const feedback = (
  e: ActionEffect,
  status: ActionFeedback["status"],
): ActionFeedback => ({ ...e.request, status });
describe("process scheduler", () => {
  it("submits once and advances seq only after matching accepted completion", () => {
    const f = fixture({
      kind: "seq",
      id: "seq",
      children: [invoke("first"), invoke("second")],
    });
    expect(f.advance()).toHaveLength(0);
    const [first] = f.advance();
    expect(first.kind).toBe("submit");
    expect(f.advance()).toHaveLength(0);
    expect(
      f.advance([feedback(first, "accepted"), feedback(first, "succeeded")]),
    ).toHaveLength(0);
    const [second] = f.advance();
    expect(second.request.requestId).not.toBe(first.request.requestId);
    f.advance([feedback(second, "accepted"), feedback(second, "succeeded")]);
    expect(f.scheduler.snapshot().status).toBe("succeeded");
  });
  it("ignores duplicate ticks and foreign-run completions", () => {
    const f = fixture(invoke("a"));
    const [request] = f.advance();
    expect(
      f.scheduler.advance({
        frame: { runId: "run", tick: 0, revision: 0, samples: {} },
        feedback: [],
      }),
    ).toHaveLength(0);
    f.advance([{ ...feedback(request, "succeeded"), runId: "old" }]);
    expect(f.scheduler.snapshot().status).toBe("running");
  });
  it("activates independent parallel devices together and joins all", () => {
    const f = fixture({
      id: "par",
      kind: "par",
      join: "all",
      children: [invoke("a"), invoke("b", "R2")],
    });
    f.advance();
    const requests = f.advance();
    expect(requests).toHaveLength(2);
    f.advance([
      feedback(requests[0], "accepted"),
      feedback(requests[0], "succeeded"),
    ]);
    expect(f.scheduler.snapshot().status).toBe("running");
    f.advance([
      feedback(requests[1], "accepted"),
      feedback(requests[1], "succeeded"),
    ]);
    expect(f.scheduler.snapshot().status).toBe("succeeded");
  });
  it("serializes competing requests without half-held resource sets", () => {
    const f = fixture({
      id: "par",
      kind: "par",
      join: "all",
      children: [invoke("a"), invoke("b")],
    });
    f.advance();
    const first = f.advance();
    expect(first).toHaveLength(1);
    const second = f.advance([
      feedback(first[0], "accepted"),
      feedback(first[0], "succeeded"),
    ]);
    expect(second).toHaveLength(1);
    const arbiter = new ResourceArbiter();
    expect(arbiter.acquire("a", ["one"])).toBe(true);
    expect(arbiter.acquire("b", ["two", "one"])).toBe(false);
    expect(arbiter.snapshot().two).toBeUndefined();
  });
  it("blocks unknown preconditions without acquiring resources", () => {
    const f = fixture(invoke("a"));
    f.facts.ready = undefined;
    expect(f.advance()).toHaveLength(0);
    expect(f.scheduler.snapshot().resources).toEqual({});
    f.facts.ready = true;
    expect(f.advance()).toHaveLength(1);
  });
  it("allocates fresh request IDs for repeat activations", () => {
    const f = fixture({
      id: "repeat",
      kind: "repeat",
      count: literal(2),
      body: invoke("item"),
    });
    let pending: ActionFeedback[] = [];
    const ids: string[] = [];
    for (
      let i = 0;
      i < 20 && f.scheduler.snapshot().status === "running";
      i++
    ) {
      const effects = f.advance(pending);
      pending = [];
      for (const e of effects) {
        ids.push(e.request.requestId);
        pending.push(feedback(e, "accepted"), feedback(e, "succeeded"));
      }
    }
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(f.scheduler.snapshot().status).toBe("succeeded");
  });
  it("selects a branch once and rejects exclusive conflicts", () => {
    const root: ProcessNode = {
      id: "branch",
      kind: "branch",
      mode: "exclusive",
      timeout: seconds(1),
      cases: [
        { condition: literal(true), body: invoke("a") },
        { condition: literal(true), body: invoke("b") },
      ],
      otherwise: { kind: "delay", id: "fallback", duration: seconds(0) },
    };
    const f = fixture(root);
    expect(f.advance()).toHaveLength(0);
    expect(f.scheduler.snapshot().status).toBe("failed");
  });
  it("requires actual stop acknowledgement after cancellation and preserves leases", () => {
    const f = fixture(invoke("a"));
    const [request] = f.advance();
    f.advance([feedback(request, "accepted")]);
    f.scheduler.cancel();
    const effects = f.advance();
    expect(effects[0].kind).toBe("cancel");
    expect(f.scheduler.snapshot().resources["device/R1"]).toBeDefined();
    f.advance([feedback(request, "stopped")]);
    expect(f.scheduler.snapshot().status).toBe("cancelled");
    expect(f.scheduler.snapshot().resources).toEqual({});
  });
  it("enters attention_required when stopping cannot be confirmed", () => {
    const f = fixture(invoke("a"));
    f.advance();
    f.scheduler.cancel();
    for (let i = 0; i < 5; i++) f.advance();
    expect(f.scheduler.snapshot().status).toBe("attention_required");
    expect(f.scheduler.snapshot().resources["device/R1"]).toBeDefined();
  });
  it("cancels active siblings after a parallel failure", () => {
    const f = fixture({
      id: "par",
      kind: "par",
      join: "all",
      children: [invoke("a"), { id: "fail", kind: "fail", code: "BROKEN" }],
    });
    f.advance();
    const effects = f.advance();
    expect(effects.map((e) => e.kind)).toEqual(["submit", "cancel"]);
    expect(f.scheduler.snapshot().status).toBe("stopping");
  });
  it("does not treat unknown inventory as empty or bypass independent finalization", () => {
    const conditions = new ConditionProviders();
    conditions.register("goal", { evaluate: () => undefined });
    const root: ProcessNode = {
      id: "rows",
      kind: "repeat",
      over: { kind: "items_at", args: [literal("station")], kwargs: {} },
      bind: "item",
      limit: literal(4),
      body: { id: "hold", kind: "delay", duration: seconds(0) },
    };
    const process = bindProcess(root, {
      scope: {},
      actions: [],
      providers: conditions,
      readers: { items_at: () => UNKNOWN },
      finalization: ["goal"],
      deadlines: { collection: 2 },
    });
    const scheduler = new ProcessScheduler("run", process);
    for (let tick = 0; tick < 3; tick++)
      scheduler.advance({
        frame: { runId: "run", tick, revision: 0, samples: {} },
        feedback: [],
      });
    expect(scheduler.snapshot().status).toBe("failed");
  });
  it("rejects missing providers, duplicate IDs and direct continuous invokes", () => {
    expect(() => fixture(invoke("a"), { preconditions: ["missing"] })).toThrow(
      "Missing",
    );
    expect(() =>
      fixture({ kind: "seq", id: "s", children: [invoke("a"), invoke("a")] }),
    ).toThrow("Duplicate");
    expect(() => fixture(invoke("a"), { continuous: true })).toThrow(
      "continuous",
    );
  });
});

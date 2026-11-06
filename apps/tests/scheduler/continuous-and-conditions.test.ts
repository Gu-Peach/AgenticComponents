import { it, expect } from "vitest";
import { bindProcess } from "../../src/domain/runtime/bindProcess";
import { ProcessScheduler, UNKNOWN } from "../../src/runtime/scheduler";
import { ConditionProviders } from "../../src/runtime/signals";
import { evaluate } from "../../src/runtime/scheduler/expressions";
import type {
  ActionFeedback,
  ActionEffect,
} from "../../src/contracts/scheduler";
it("runs a continuous scope only after entry confirmation and exits with physical stop", () => {
  const p = new ConditionProviders();
  p.register("yes", { evaluate: () => true });
  const process = bindProcess(
    {
      kind: "with-control",
      id: "control",
      device: { kind: "ref", name: "C1" },
      control: "drive",
      setpoints: { kind: "map", items: {} },
      body: {
        kind: "delay",
        id: "hold",
        duration: {
          kind: "seconds",
          args: [{ kind: "literal", value: 0 }],
          kwargs: {},
        },
      },
    },
    {
      scope: { C1: "C1" },
      providers: p,
      actions: [
        {
          device: "C1",
          behavior: "drive",
          continuous: true,
          preconditions: ["yes"],
          authorization: [],
          sustaining: ["yes"],
          completion: ["yes"],
          release: [],
          stopped: ["yes"],
          resources: () => [],
          validateArguments: () => {},
        },
      ],
      finalization: ["yes"],
    },
  );
  const scheduler = new ProcessScheduler("run", process);
  const step = (tick: number, feedback: ActionFeedback[] = []) =>
    scheduler.advance({
      frame: { runId: "run", tick, revision: 0, samples: {} },
      feedback,
    });
  const first = step(0)[0];
  step(1, [{ ...first.request, status: "accepted" }]);
  const stop = step(2);
  expect(stop[0].kind).toBe("cancel");
  expect(scheduler.snapshot().status).toBe("running");
  step(3, [{ ...first.request, status: "stopped" }]);
  expect(scheduler.snapshot().status).toBe("succeeded");
});
it("keeps finalization pending when the independent goal is unknown", () => {
  const p = new ConditionProviders();
  p.register("goal", { evaluate: () => undefined });
  const process = bindProcess(
    {
      kind: "delay",
      id: "end",
      duration: {
        kind: "seconds",
        args: [{ kind: "literal", value: 0 }],
        kwargs: {},
      },
    },
    {
      scope: {},
      actions: [],
      providers: p,
      finalization: ["goal"],
      deadlines: { finalization: 2 },
    },
  );
  const s = new ProcessScheduler("run", process);
  for (let tick = 0; tick < 3; tick++)
    s.advance({
      frame: { runId: "run", tick, revision: 0, samples: {} },
      feedback: [],
    });
  expect(s.snapshot().status).toBe("failed");
});
it("implements three-valued Boolean logic", () => {
  const context = {
    frame: { runId: "r", tick: 0, revision: 0, samples: {} },
    tick: 0,
    scope: {},
    owns: () => false,
  };
  const unknown = {
    kind: "fact" as const,
    args: [{ kind: "literal" as const, value: "unknown" }],
    kwargs: {},
  };
  expect(
    evaluate(
      {
        kind: "all_of",
        args: [{ kind: "literal", value: false }, unknown],
        kwargs: {},
      },
      context,
      { fact: () => UNKNOWN },
    ),
  ).toBe(false);
  expect(
    evaluate(
      {
        kind: "any_of",
        args: [{ kind: "literal", value: true }, unknown],
        kwargs: {},
      },
      context,
      { fact: () => UNKNOWN },
    ),
  ).toBe(true);
});
it("does not reuse a completion whose sustaining condition has failed", () => {
  let alive = true;
  const p = new ConditionProviders();
  p.register("yes", { evaluate: () => true });
  p.register("alive", { evaluate: () => alive });
  const process = bindProcess(
    {
      kind: "invoke",
      id: "a",
      device: { kind: "ref", name: "R1" },
      behavior: "move",
      arguments: {},
    },
    {
      scope: { R1: "R1" },
      providers: p,
      actions: [
        {
          device: "R1",
          behavior: "move",
          preconditions: ["yes"],
          authorization: [],
          sustaining: ["alive"],
          completion: ["yes"],
          release: [],
          stopped: ["yes"],
          resources: () => [],
          validateArguments: () => {},
        },
      ],
      finalization: ["yes"],
    },
  );
  const s = new ProcessScheduler("run", process);
  const first = s.advance({
    frame: { runId: "run", tick: 0, revision: 0, samples: {} },
    feedback: [],
  })[0] as ActionEffect;
  alive = false;
  s.advance({
    frame: { runId: "run", tick: 1, revision: 0, samples: {} },
    feedback: [
      { ...first.request, status: "accepted" },
      { ...first.request, status: "succeeded" },
    ],
  });
  expect(s.snapshot().status).toBe("stopping");
});

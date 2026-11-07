import { it, expect } from "vitest";
import { sceneFixture } from "../assembly/fixtures";
import { compileSceneRuntime } from "../../src/domain/runtime/compileSceneRuntime";
import { compileConditions } from "../../src/domain/runtime/compileConditions";
import { sceneConditionReader } from "../../src/runtime/assembly/SceneConditionBindings";
import { compileSceneLadder } from "../../src/domain/runtime/compileSceneLadder";
import type { ConditionContext } from "../../src/contracts/conditions";
import type { SchedulerSnapshot } from "../../src/contracts/scheduler";
import { selectSceneActivation } from "../../src/domain/runtime/selectSceneActivation";
import { SignalRegistry } from "../../src/runtime/signals/SignalRegistry";
const fixture = sceneFixture(),
  compiled = compileSceneRuntime(
    fixture.bundle,
    fixture.bytes,
    fixture.goal,
    "validation",
  );
const rules = compileConditions(
  "R1",
  compiled.devices.get("R1")!.contract,
  "pick_and_place",
);
const binding = rules.find((c) => c.phase === "completion")!.bindings[
  "pick_and_place.holding_material_request_subject"
];
const reader = sceneConditionReader("scene", "R1", compiled, new Map(), []);
it("does not display previous-loop Done while the new loop has not created its next action", () => {
  const process: SchedulerSnapshot = {
    runId: "r",
    tick: 5,
    status: "running",
    resources: {},
    activations: [
      {
        id: "loop",
        node: "repeat",
        state: "pending",
        iteration: 2,
        totalIterations: 3,
        blockedBy: [],
      },
      {
        id: "body1",
        node: "body",
        parentId: "loop",
        state: "succeeded",
        blockedBy: [],
      },
      {
        id: "pick1",
        node: "pick",
        parentId: "body1",
        state: "succeeded",
        blockedBy: [],
      },
    ],
  };
  expect(selectSceneActivation(process, "pick")).toBeUndefined();
  process.activations.push({
    id: "body2",
    node: "body",
    parentId: "loop",
    state: "pending",
    blockedBy: [],
  });
  expect(selectSceneActivation(process, "pick")).toBeUndefined();
  process.activations.push({
    id: "pick2",
    node: "pick",
    parentId: "body2",
    state: "waiting_preconditions",
    blockedBy: [],
  });
  expect(selectSceneActivation(process, "pick")?.id).toBe("pick2");
});
it("preserves short acceptance pulses even when the current UI snapshot shows FALSE", () => {
  const signals = new SignalRegistry("r", [
    {
      key: "s/R/accepted",
      direction: "output",
      type: "BOOL",
      writer: "adapter:R",
    },
  ]);
  for (const [tick, value] of [
    [1, true],
    [2, false],
  ] as const)
    signals.publishFeedback(
      [
        {
          key: "s/R/accepted",
          runId: "r",
          writer: "adapter:R",
          requestId: "1",
          activationId: "a",
          value,
        },
      ],
      tick,
    );
  expect(signals.snapshot().samples["s/R/accepted"].value).toBe(false);
  expect(signals.trace().events.map((e) => e.sample.value)).toEqual([
    true,
    false,
  ]);
});
function context(): ConditionContext {
  return {
    tick: 10,
    nodeId: "pick",
    activationId: "a",
    phase: "completion",
    frame: {
      runId: "run",
      tick: 10,
      revision: 1,
      samples: {
        "scene/R1/holding_material": {
          runId: "run",
          requestId: "1",
          activationId: "a",
          subjectId: "M01_01",
          quality: "good",
          value: false,
          sampledTick: 10,
          changedTick: 10,
          writer: "adapter:R1",
        },
      },
    },
    scope: {},
    owns: () => false,
    request: {
      runId: "run",
      requestId: "1",
      activationId: "a",
      subjectId: "M01_01",
      device: "R1",
    },
    requestState: { accepted: true, outcome: "succeeded", stopped: false },
  };
}
it("reads matched physical feedback and rejects old runs, old requests and wrong subjects", () => {
  expect(reader(binding, context()).value).toBe(false);
  for (const key of [
    "runId",
    "requestId",
    "activationId",
    "subjectId",
  ] as const) {
    const c = context();
    c.frame = {
      ...c.frame,
      samples: {
        "scene/R1/holding_material": {
          ...c.frame.samples["scene/R1/holding_material"],
          [key]: "old",
        },
      },
    };
    expect(reader(binding, c).quality).toBe("invalid");
  }
});
it("keeps persistent command permits valid while sampled feedback expires", () => {
  const c = context();
  c.frame = {
    ...c.frame,
    samples: {
      "scene/R1/holding_material": {
        ...c.frame.samples["scene/R1/holding_material"],
        sampledTick: 0,
      },
    },
  };
  expect(reader(binding, c)).toMatchObject({ value: null, quality: "stale" });
  const rule = compileConditions(
    "C3",
    compiled.devices.get("C3")!.contract,
    "release_material",
  ).find((r) => r.phase === "sustaining")!;
  const permit = rule.bindings["release_material.release_waiting_material_run"],
    read = sceneConditionReader("scene", "C3", compiled, new Map(), []);
  c.frame = {
    ...c.frame,
    samples: {
      "scene/C3/release_waiting_material": {
        runId: "run",
        quality: "good",
        value: true,
        sampledTick: 0,
        changedTick: 0,
        writer: "process",
      },
    },
  };
  expect(read(permit, c)).toMatchObject({
    value: true,
    quality: "good",
    sampledTick: 0,
  });
});
it("retains stale/invalid/disconnected quality and never uses old Done as request success", () => {
  for (const quality of ["stale", "invalid", "disconnected"] as const) {
    const c = context();
    c.frame = {
      ...c.frame,
      samples: {
        "scene/R1/holding_material": {
          ...c.frame.samples["scene/R1/holding_material"],
          quality,
        },
      },
    };
    expect(reader(binding, c)).toMatchObject({ value: null, quality });
  }
  const success = rules.find((c) => c.phase === "completion")!.bindings[
      "pick_and_place.matching_success"
    ],
    c = context();
  c.requestState = { accepted: false, stopped: false };
  expect(reader(success, c).value).toBe(false);
});
it("builds per-invocation rungs, explicit AND joins and finite loops without device-specific layout branches", () => {
  const graph = compileSceneLadder(fixture.bundle),
    calls = graph.rungs.filter((r) => r.kind === "invoke");
  expect(calls).toHaveLength(fixture.bundle.calls.length);
  expect(calls.filter((r) => r.device === "R1")).toHaveLength(2);
  const join = graph.rungs.find((r) => r.id === "sort_pallet/join")!;
  expect(join.children).toEqual(["gray_items", "brown_items"]);
  expect(join.kind).toBe("join");
  expect(calls.find((r) => r.id === "mainline_to_exit")?.predecessor).toBe(
    "sort_pallet",
  );
  expect(graph.rungs.some((r) => r.kind === "repeat")).toBe(true);
});

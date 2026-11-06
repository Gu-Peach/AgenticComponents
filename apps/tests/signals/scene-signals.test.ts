import { describe, it, expect } from "vitest";
import {
  SignalRegistry,
  ConditionProviders,
  signalEquals,
} from "../../src/runtime/signals";
import type {
  SceneSignalDefinition,
  SignalWrite,
} from "../../src/contracts/scene-signals";
const definitions: SceneSignalDefinition[] = [
  {
    key: "scene/R1/execute",
    direction: "input",
    type: "BOOL",
    writer: "process",
  },
  {
    key: "scene/R1/request_id",
    direction: "input",
    type: "DINT",
    writer: "process",
  },
  {
    key: "scene/R1/done",
    direction: "output",
    type: "BOOL",
    writer: "adapter:R1",
  },
  {
    key: "scene/R1/position",
    direction: "output",
    type: "REAL",
    writer: "adapter:R1",
    maxAgeTicks: 2,
  },
];
const write = (
  key: string,
  value: boolean | number | null,
  writer = "process",
): SignalWrite => ({ key, value, writer, runId: "run" });
describe("scene signal frames", () => {
  it("starts unknown and commits parameter/trigger writes atomically", () => {
    const registry = new SignalRegistry("run", definitions);
    expect(registry.snapshot().samples["scene/R1/execute"].quality).toBe(
      "unknown",
    );
    expect(() =>
      registry.commitInputs(
        [
          write("scene/R1/execute", true),
          write("scene/R1/request_id", 2 ** 31),
        ],
        1,
      ),
    ).toThrow();
    expect(registry.snapshot().samples["scene/R1/execute"].value).toBeNull();
    registry.commitInputs(
      [write("scene/R1/execute", true), write("scene/R1/request_id", 1)],
      1,
    );
    expect(registry.snapshot().samples["scene/R1/execute"].value).toBe(true);
  });
  it("rejects multiwriter, duplicates, wrong run, wrong direction and types", () => {
    const registry = new SignalRegistry("run", definitions);
    for (const writes of [
      [write("scene/R1/execute", true, "manual")],
      [write("scene/R1/execute", true), write("scene/R1/execute", false)],
      [{ ...write("scene/R1/execute", true), runId: "old" }],
      [write("scene/R1/done", true)],
      [write("scene/R1/request_id", 1.5)],
    ])
      expect(() => registry.commitInputs(writes, 1)).toThrow();
  });
  it("separates freshness from changed values and keeps latched results", () => {
    const registry = new SignalRegistry("run", definitions);
    registry.publishFeedback(
      [
        write("scene/R1/position", 1, "adapter:R1"),
        write("scene/R1/done", true, "adapter:R1"),
      ],
      1,
    );
    registry.publishFeedback([write("scene/R1/position", 1, "adapter:R1")], 2);
    expect(registry.snapshot(4).samples["scene/R1/position"].quality).toBe(
      "good",
    );
    expect(registry.snapshot(5).samples["scene/R1/position"].quality).toBe(
      "stale",
    );
    expect(registry.snapshot(5).samples["scene/R1/done"].quality).toBe("good");
    expect(registry.snapshot().samples["scene/R1/position"].changedTick).toBe(
      1,
    );
    expect(() => {
      (
        registry.snapshot().samples["scene/R1/done"] as { value: unknown }
      ).value = false;
    }).toThrow();
  });
  it("rejects invalid REAL and records trace gaps explicitly", () => {
    const registry = new SignalRegistry("run", definitions, 1);
    expect(() =>
      registry.publishFeedback(
        [write("scene/R1/position", Infinity, "adapter:R1")],
        0,
      ),
    ).toThrow();
    registry.publishFeedback([write("scene/R1/done", true, "adapter:R1")], 1);
    registry.publishFeedback([write("scene/R1/done", false, "adapter:R1")], 2);
    expect(registry.trace(0).lost).toBe(true);
    expect(registry.trace(1).lost).toBe(false);
  });
  it("does not let a previous request completion satisfy the next one", () => {
    const registry = new SignalRegistry("run", definitions);
    registry.publishFeedback(
      [
        {
          ...write("scene/R1/done", true, "adapter:R1"),
          requestId: "1",
          activationId: "a",
        },
      ],
      1,
    );
    const p = signalEquals("scene/R1/done", true, true);
    const c = {
      frame: registry.snapshot(),
      tick: 1,
      scope: {},
      owns: () => false,
      request: {
        runId: "run",
        requestId: "2",
        activationId: "b",
        device: "R1",
      },
    };
    expect(p.evaluate(c, {})).toBeUndefined();
  });
  it("rejects unknown and circular condition dependencies", () => {
    const p = new ConditionProviders();
    p.register("done", { dependencies: ["completion"], evaluate: () => true });
    p.register("completion", { dependencies: ["done"], evaluate: () => true });
    expect(() => p.validate(["done"])).toThrow("cycle");
    expect(() => p.validate(["missing"])).toThrow("Missing");
  });
});

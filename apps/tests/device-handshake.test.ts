import { expect, it } from "vitest";
import type { ActionRequest } from "@/contracts/scheduler";
import type { SceneSignalDefinition } from "@/contracts/scene-signals";
import { WarehouseActionAdapter } from "@/runtime/adapters/scene/WarehouseActionAdapter";
import { SignalRegistry } from "@/runtime/signals/SignalRegistry";

function fixture(extended = true) {
  const id = "station";
  const run = "r";
  const prefix = "line/station/";
  const input = ["execute", "request_id", ...(extended ? ["reset"] : [])];
  const output = [
    "accepted",
    "busy",
    "done",
    "result_id",
    "error",
    ...(extended ? ["error_code"] : []),
  ];
  const layout: SceneSignalDefinition[] = [...input, ...output].map((port) => ({
    key: prefix + port,
    direction: input.includes(port) ? "input" : "output",
    type: ["request_id", "result_id"].includes(port)
      ? "DINT"
      : port === "error_code"
        ? "INT"
        : "BOOL",
    writer: input.includes(port) ? "process" : "adapter:" + id,
  }));
  const signals = new SignalRegistry(run, layout);
  const mechanics = {
    starts: 0,
    done: false,
    fault: false,
    stopped: true,
    causeCleared: false,
    material: "",
  };
  const driver = new WarehouseActionAdapter(
    id,
    "line",
    run,
    ["carry"],
    (request) => ({
      begin() {
        mechanics.starts++;
        mechanics.material = String(request.arguments.material);
      },
      before() {},
      after() {
        if (mechanics.fault) throw new Error("lost support");
      },
      complete: () => mechanics.done,
      cancel() {},
      stopped: () => mechanics.stopped,
      canResetFault: () => mechanics.causeCleared,
    }),
    () => mechanics.stopped,
  );
  let tick = 0;
  function scan() {
    driver.sampleInputs(signals.snapshot(tick));
    driver.beforePhysics(1 / 60);
    driver.afterPhysics(1 / 60, ++tick);
    signals.publishFeedback(driver.drainSignals(), tick);
    return driver.drainFeedback();
  }
  function request(n: number): ActionRequest {
    return {
      device: id,
      runId: run,
      requestId: String(n),
      activationId: "node/" + n,
      behavior: "carry",
      arguments: { material: "M1" },
    };
  }
  function submit(r: ActionRequest) {
    const writes = driver.prepare(r, signals.snapshot(tick));
    signals.commitInputs(writes, tick);
    driver.submit(r);
  }
  function inputValue(port: string, value: boolean) {
    signals.commitInputs(
      [{ key: prefix + port, writer: "process", runId: run, value }],
      tick,
    );
  }
  function outputValue(port: string) {
    return signals.snapshot(tick).samples[prefix + port]?.value;
  }
  return {
    driver,
    signals,
    scan,
    request,
    submit,
    inputValue,
    outputValue,
    mechanics,
    tick: () => tick,
  };
}

it("holds acceptance until request withdrawal and preserves a correlated result until the next acceptance", () => {
  const f = fixture(),
    r = f.request(41);
  f.submit(r);
  // Changing the caller's payload after submission cannot alter the frozen job.
  (r.arguments as { material: string }).material = "wrong";
  const [accepted] = f.scan();
  expect(accepted.status).toBe("accepted");
  expect(f.mechanics.material).toBe("M1");
  for (let i = 0; i < 3; i++) expect(f.scan()).toEqual([]);
  expect(f.outputValue("accepted")).toBe(true);
  expect(f.outputValue("busy")).toBe(true);
  expect(f.outputValue("result_id")).toBe(0);
  expect(
    f.driver.acknowledge(
      { ...accepted, activationId: "another" },
      f.signals.snapshot(f.tick()),
    ),
  ).toEqual([]);
  const ack = f.driver.acknowledge(accepted, f.signals.snapshot(f.tick()));
  f.signals.commitInputs(ack, f.tick());
  expect(f.scan()).toEqual([]);
  expect(f.outputValue("accepted")).toBe(false);
  expect(f.outputValue("busy")).toBe(true);
  f.mechanics.done = true;
  expect(f.scan().map((x) => x.status)).toEqual(["succeeded"]);
  for (let i = 0; i < 3; i++) f.scan();
  expect(f.outputValue("done")).toBe(true);
  expect(f.outputValue("result_id")).toBe(41);
  expect(f.outputValue("busy")).toBe(false);
  expect(() => f.submit(f.request(41))).toThrow();
  expect(f.mechanics.starts).toBe(1);
  f.mechanics.done = false;
  f.submit(f.request(42));
  expect(f.outputValue("done")).toBe(true);
  expect(f.scan().map((x) => x.status)).toEqual(["accepted"]);
  expect(f.outputValue("done")).toBe(false);
  expect(f.outputValue("result_id")).toBe(0);
  f.mechanics.done = true;
  f.scan();
  f.driver.requestStop();
  f.scan();
  expect(f.outputValue("done")).toBe(true);
  expect(f.outputValue("result_id")).toBe(42);
});

it("rejects another start while execute is still asserted, even for an instant job", () => {
  const f = fixture();
  f.mechanics.done = true;
  f.submit(f.request(1));
  expect(f.scan().map((x) => x.status)).toEqual(["accepted", "succeeded"]);
  expect(() => f.submit(f.request(2))).toThrow();
  expect(f.outputValue("accepted")).toBe(true);
  f.inputValue("execute", false);
  f.scan();
  expect(f.outputValue("accepted")).toBe(false);
  expect(() => f.submit(f.request(2))).not.toThrow();
});

it("latches faults and only resets on a new request after the physical cause has cleared", () => {
  const f = fixture();
  f.mechanics.fault = true;
  f.submit(f.request(17));
  expect(f.scan().map((x) => x.status)).toEqual(["accepted", "failed"]);
  expect(f.outputValue("error")).toBe(true);
  expect(f.outputValue("error_code")).toBe(1);
  expect(f.outputValue("done")).toBe(false);
  expect(f.outputValue("result_id")).toBe(17);
  f.inputValue("execute", false);
  f.inputValue("reset", true);
  f.scan();
  expect(f.outputValue("error")).toBe(true);
  f.mechanics.causeCleared = true;
  f.mechanics.fault = false;
  f.scan();
  expect(f.outputValue("error")).toBe(true);
  f.inputValue("reset", false);
  f.scan();
  f.inputValue("reset", true);
  f.scan();
  expect(f.outputValue("error")).toBe(false);
  expect(f.outputValue("error_code")).toBe(0);
  expect(f.outputValue("done")).toBe(false);
  expect(f.outputValue("result_id")).toBe(17);
  expect(() => f.submit(f.request(18))).not.toThrow();
});

it("retains the limited feedback layout of historical profiles", () => {
  const f = fixture(false);
  f.mechanics.fault = true;
  f.submit(f.request(9));
  f.scan();
  expect(f.outputValue("error")).toBe(true);
  expect(f.outputValue("error_code")).toBeUndefined();
  expect(() => f.inputValue("reset", true)).toThrow();
});

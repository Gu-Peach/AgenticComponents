import { describe, it, expect, vi } from "vitest";
import { PreviewController } from "../src/runtime/PreviewController";
import { ExecutorRegistry } from "../src/runtime/ExecutorRegistry";
import { mockAdapter } from "../src/runtime/adapters/MockAdapter";
import { createDemoProject } from "../src/domain/catalog";
import type {
  AnimationAdapter,
  PreviewRequest,
  PreviewSession,
  PreviewContext,
} from "../src/contracts/preview";
const context: PreviewContext = {
  hasNode: () => true,
  readNode: () => null,
  writeNode: () => {},
  log: () => {},
};
function setup(
  adapter: AnimationAdapter = mockAdapter,
  mode: "mock" | "real" = "mock",
) {
  const p = createDemoProject();
  const def = p.definitions[0];
  if (mode === "real") {
    def.template = false;
    def.behaviors[0].preconditions = [];
    def.behaviors[0].executorRef = adapter.id;
  }
  const r = new ExecutorRegistry();
  r.register(adapter);
  const c = new PreviewController(r, context, () => {});
  const request: PreviewRequest = {
    requestId: crypto.randomUUID(),
    instanceId: p.instances[0].instanceId,
    behaviorId: def.behaviors[0].id,
    definitionRevision: def.revision,
    sceneRevision: p.revision,
    args: {},
    mode,
  };
  return { c, p, request };
}
describe("preview lifecycle", () => {
  it("keeps previews out of the project, pauses time and completes as mock evidence", async () => {
    const { c, p, request } = setup();
    const before = JSON.stringify(p);
    await c.start(request, p);
    c.tick(1);
    c.pause();
    c.tick(1);
    expect(c.getSnapshot().time).toBe(1);
    c.resume();
    c.tick(5.1);
    expect(c.getSnapshot().result?.evidence).toBe("mock");
    expect(c.getSnapshot().status).toBe("succeeded");
    expect(JSON.stringify(p)).toBe(before);
    await expect(c.start(request, p)).rejects.toThrow("已使用");
  });
  it("rejects duplicate start while running; stopping is cancellation", async () => {
    const { c, p, request } = setup();
    await c.start(request, p);
    await expect(
      c.start({ ...request, requestId: "another" }, p),
    ).rejects.toThrow("活动");
    await c.stop();
    expect(c.getSnapshot().status).toBe("cancelled");
  });
  it("disposes a late prepared session without starting it after cancellation", async () => {
    let resolve!: (s: PreviewSession) => void;
    const adapter: AnimationAdapter = {
      ...mockAdapter,
      prepare: () =>
        new Promise((r) => {
          resolve = r;
        }),
    };
    const { c, p, request } = setup(adapter);
    const pending = c.start(request, p);
    await c.stop();
    const session = await mockAdapter.prepare(
      {
        request,
        instance: p.instances[0],
        definition: p.definitions[0],
        behavior: p.definitions[0].behaviors[0],
        parameters: {},
        affectedInstanceIds: [],
      },
      context,
      new AbortController().signal,
    );
    const start = vi.spyOn(session, "start");
    const dispose = vi.spyOn(session, "dispose");
    resolve(session);
    await pending;
    expect(start).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(c.getSnapshot().status).toBe("cancelled");
  });
  it("does not infer physical completion from 100% progress", async () => {
    const adapter: AnimationAdapter = {
      ...mockAdapter,
      id: "real",
      async prepare(input, ctx, signal) {
        const s = await mockAdapter.prepare(input, ctx, signal);
        return {
          ...s,
          tick: () => ({ progress: 1, observations: {} }),
          result: () => null,
        };
      },
    };
    const { c, p, request } = setup(adapter, "real");
    await c.start(request, p);
    c.tick(10);
    expect(c.getSnapshot().status).toBe("running");
  });
  it("fails a real success lacking completion observations", async () => {
    const adapter: AnimationAdapter = {
      ...mockAdapter,
      id: "real",
      async prepare(input, ctx, signal) {
        const s = await mockAdapter.prepare(input, ctx, signal);
        return {
          ...s,
          result: () => ({
            requestId: input.request.requestId,
            status: "succeeded",
            evidence: "observed",
            observations: {},
            issues: [],
          }),
        };
      },
    };
    const { c, p, request } = setup(adapter, "real");
    await c.start(request, p);
    c.tick(1);
    expect(c.getSnapshot().status).toBe("failed");
    expect(c.getSnapshot().error).toContain("完成观测");
  });
  it("blocks unknown real preconditions and stale scene revisions", async () => {
    const { c, p, request } = setup(mockAdapter, "real");
    p.definitions[0].behaviors[0].preconditions = [
      {
        id: "material",
        label: "入口有料",
        source: "observation",
        key: "material",
        equals: true,
      },
    ];
    await expect(c.start(request, p)).rejects.toThrow("未知");
    await expect(c.start({ ...request, sceneRevision: 12 }, p)).rejects.toThrow(
      "版本",
    );
  });
});

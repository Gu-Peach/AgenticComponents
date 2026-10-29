import type {
  AnimationAdapter,
  PreviewResult,
  PreviewSession,
} from "@/contracts/preview";
/** Exercises the contract lifecycle only; never reports physical success. */
export const mockAdapter: AnimationAdapter = {
  id: "builtin.mock",
  capabilities: () => ({
    supportedBehaviors: ["*"],
    supportsPause: true,
    supportsRestore: true,
  }),
  validate: () => [],
  async prepare(input, context, signal): Promise<PreviewSession> {
    signal.throwIfAborted();
    let elapsed = 0;
    let paused = false;
    let disposed = false;
    let terminal: PreviewResult | null = null;
    context.log("演示模式：以模拟时间验证界面通路，不执行设备运动或物料交接");
    return {
      sessionId: input.request.requestId,
      start() {},
      tick(dt) {
        if (!paused && !disposed && !terminal) elapsed += dt;
        const progress = Math.min(elapsed / 6, 1);
        if (progress >= 1 && !terminal)
          terminal = {
            requestId: input.request.requestId,
            status: "succeeded",
            evidence: "mock",
            observations: { demo_cycle: true },
            issues: [],
          };
        return {
          progress,
          observations: {
            demo_time: Number(elapsed.toFixed(2)),
            simulated: true,
          },
        };
      },
      pause() {
        paused = true;
      },
      resume() {
        paused = false;
      },
      result() {
        return terminal;
      },
      async stop() {
        terminal = {
          requestId: input.request.requestId,
          status: "cancelled",
          evidence: "mock",
          observations: {},
          issues: [],
        };
        return terminal;
      },
      async restoreBaseline() {
        elapsed = 0;
      },
      dispose() {
        disposed = true;
      },
    };
  },
};

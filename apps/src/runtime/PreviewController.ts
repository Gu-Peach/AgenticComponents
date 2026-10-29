import type { ProjectDocument, ParamValue } from "@/contracts/device";
import {
  isActive,
  type PreviewContext,
  type PreviewRequest,
  type PreviewSession,
  type PreviewSnapshot,
  type PreviewResult,
} from "@/contracts/preview";
import {
  resolveParameters,
  semanticIssues,
  validateParameters,
} from "@/validation/contracts";
import { evaluateConditions } from "./ConditionEvaluator";
import { ExecutorRegistry } from "./ExecutorRegistry";
const initial: PreviewSnapshot = {
  status: "idle",
  time: 0,
  progress: 0,
  observations: {},
  supportsPause: false,
  supportsRestore: false,
};
export class PreviewController {
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private session?: PreviewSession;
  private abort?: AbortController;
  private generation = 0;
  private seen = new Set<string>();
  private stopTask?: Promise<void>;
  constructor(
    private registry: ExecutorRegistry,
    private context: PreviewContext,
    private log: (message: string) => void,
    private readObservations: (
      instanceId: string,
    ) => Record<string, ParamValue> = () => ({}),
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private patch(patch: Partial<PreviewSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  async start(request: PreviewRequest, project: ProjectDocument) {
    if (isActive(this.snapshot.status))
      throw new Error("已有活动预览，请先停止");
    if (this.seen.has(request.requestId)) throw new Error("请求 ID 已使用");
    const instance = project.instances.find(
      (i) => i.instanceId === request.instanceId,
    );
    const definition = project.definitions.find(
      (d) => d.specId === instance?.specId,
    );
    const behavior = definition?.behaviors.find(
      (b) => b.id === request.behaviorId,
    );
    if (!instance || !definition || !behavior)
      throw new Error("设备或行为不存在");
    if (!["action", "service"].includes(behavior.kind))
      throw new Error("该行为不可直接调用");
    if (
      request.sceneRevision !== project.revision ||
      request.definitionRevision !== definition.revision ||
      instance.specRevision !== definition.revision
    )
      throw new Error("场景或设备版本已变化");
    const adapter = this.registry.get(
      request.mode === "mock" ? "builtin.mock" : behavior.executorRef,
    );
    if (!adapter) throw new Error("真实动作执行器未接入");
    const capabilities = adapter.capabilities();
    if (
      !capabilities.supportedBehaviors.includes("*") &&
      !capabilities.supportedBehaviors.includes(behavior.id)
    )
      throw new Error("执行器不支持此行为");
    const parameters = resolveParameters(definition, instance.paramOverrides);
    const issues = [
      ...semanticIssues(definition, instance.paramOverrides),
      ...validateParameters(behavior.arguments, request.args),
    ];
    if (request.mode === "real") {
      const conditions = evaluateConditions(
        behavior.preconditions,
        parameters,
        this.readObservations(instance.instanceId),
        { local_preview: true },
      );
      issues.push(
        ...conditions
          .filter((c) => c.state !== "satisfied")
          .map(
            (c) => `${c.label}: ${c.state === "unknown" ? "未知" : "不满足"}`,
          ),
      );
      if (!behavior.completionChecks.length)
        issues.push("缺少可核验的完成观测契约");
      if (definition.template) issues.push("模板尚未完成设备标定");
    }
    const input = structuredClone({
      request,
      definition,
      instance,
      behavior,
      parameters,
      affectedInstanceIds: [instance.instanceId],
    });
    issues.push(
      ...adapter
        .validate(input)
        .filter((i) => i.severity === "error")
        .map((i) => i.message),
    );
    if (issues.length) throw new Error(issues.join("；"));
    this.completionValid = (result) =>
      evaluateConditions(
        behavior.completionChecks,
        parameters,
        result.observations,
        {},
      ).every((c) => c.state === "satisfied");
    this.session?.dispose();
    this.session = undefined;
    this.seen.add(request.requestId);
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.snapshot = {
      ...initial,
      status: "preparing",
      request,
      supportsPause: capabilities.supportsPause,
      supportsRestore: capabilities.supportsRestore,
    };
    this.patch({});
    this.log(
      `${request.mode === "mock" ? "[演示 MOCK]" : "[真实]"} 接受 ${instance.name} / ${behavior.id} / ${request.requestId}`,
    );
    const assertOwned = (id: string) => {
      if (
        !input.affectedInstanceIds.includes(id) ||
        generation !== this.generation ||
        abort.signal.aborted
      )
        throw new Error("会话无权访问此对象");
    };
    const context: PreviewContext = {
      hasNode: (id, node) => {
        assertOwned(id);
        return this.context.hasNode(id, node);
      },
      readNode: (id, node) => {
        assertOwned(id);
        return this.context.readNode(id, node);
      },
      writeNode: (id, node, pose) => {
        assertOwned(id);
        this.context.writeNode(id, node, pose);
      },
      log: (message) => {
        if (generation === this.generation) this.log(message);
      },
    };
    try {
      const session = await adapter.prepare(input, context, abort.signal);
      if (generation !== this.generation || abort.signal.aborted) {
        session.dispose();
        return;
      }
      this.session = session;
      session.start();
      this.patch({ status: "running" });
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }
  tick(dt: number) {
    if (this.snapshot.status !== "running" || !this.session) return;
    try {
      const time = this.snapshot.time + dt;
      const frame = this.session.tick(dt, time);
      this.patch({
        time,
        progress: Math.max(
          0,
          Math.min(1, frame.progress ?? this.snapshot.progress),
        ),
        observations: frame.observations,
      });
      const result = this.session.result();
      if (result) {
        if (result.requestId !== this.snapshot.request?.requestId)
          throw new Error("执行器返回了其他请求的结果");
        if (
          result.status === "succeeded" &&
          this.snapshot.request?.mode === "real"
        ) {
          if (result.evidence !== "observed")
            throw new Error("真实预览缺少观测证据");
          if (!this.completionValid?.(result))
            throw new Error("完成观测未满足契约");
        }
        this.patch({ status: result.status, result });
        this.log(`预览 ${result.status}，证据 ${result.evidence}`);
      }
    } catch (e) {
      this.fail(e);
    }
  }
  private completionValid?: (result: PreviewResult) => boolean;
  pause() {
    if (this.snapshot.status === "running" && this.snapshot.supportsPause) {
      try {
        this.session?.pause();
        this.patch({ status: "paused" });
        this.log("预览已暂停");
      } catch (e) {
        this.fail(e);
      }
    }
  }
  resume() {
    if (this.snapshot.status === "paused") {
      try {
        this.session?.resume();
        this.patch({ status: "running" });
      } catch (e) {
        this.fail(e);
      }
    }
  }
  stop(reason = "用户停止"): Promise<void> {
    if (this.stopTask) return this.stopTask;
    if (!isActive(this.snapshot.status)) return Promise.resolve();
    const request = this.snapshot.request!;
    if (this.snapshot.status === "preparing") {
      this.abort?.abort();
      ++this.generation;
      this.patch({
        status: "cancelled",
        result: {
          requestId: request.requestId,
          status: "cancelled",
          evidence: request.mode === "mock" ? "mock" : "observed",
          observations: {},
          issues: [],
        },
      });
      this.log("准备已取消，迟到结果将被丢弃");
      return Promise.resolve();
    }
    this.patch({ status: "stopping" });
    this.stopTask = (async () => {
      try {
        const result = await this.session!.stop(reason);
        if (
          result.requestId !== request.requestId ||
          result.status === "succeeded"
        )
          throw new Error("停止确认必须返回当前请求的 cancelled 或 failed");
        this.patch({ status: result.status, result });
        this.log(`预览已停止：${reason}`);
      } catch (e) {
        this.fail(e);
      } finally {
        this.stopTask = undefined;
      }
    })();
    return this.stopTask;
  }
  async restore() {
    const generation = this.generation;
    await this.stop("恢复基线");
    if (generation !== this.generation) return;
    if (this.session && this.snapshot.supportsRestore) {
      const status = this.snapshot.status;
      this.patch({ status: "stopping" });
      try {
        await this.session.restoreBaseline();
        if (generation === this.generation) {
          this.patch({ status, progress: 0, observations: {}, time: 0 });
          this.log("预览基线已恢复，项目位姿未改变");
        }
      } catch (e) {
        if (generation === this.generation) this.fail(e);
      }
    }
  }
  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.session?.dispose();
    this.session = undefined;
    this.patch({ status: "failed", error: message });
    this.log(`预览失败：${message}`);
  }
  async reset() {
    await this.stop("工作区切换");
    this.abort?.abort();
    ++this.generation;
    this.session?.dispose();
    this.session = undefined;
    this.snapshot = initial;
    this.patch({});
  }
}

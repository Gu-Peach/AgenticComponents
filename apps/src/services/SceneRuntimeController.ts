import type {
  SceneRuntimeProgram,
  SceneRuntimeSnapshot,
  SceneVisualSnapshot,
} from "@/runtime/engine/SceneRuntimeProgram";
import type { ScenePackageInstance } from "@/contracts/scene-package";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  sceneClockRate,
  startRuntimeClock,
} from "@/runtime/engine/RuntimeClock";
import { useWorkspace } from "@/stores/workspace";
import { prepareScenePackage } from "./prepareScenePackage";
export interface PreparationState {
  status: "preparing" | "ready" | "blocked";
  error?: string;
  warnings: string[];
}
interface VisualFrame {
  previous: SceneVisualSnapshot;
  current: SceneVisualSnapshot;
  alpha: number;
}
/** Explicitly attaches prepared sessions; never promotes a public bundle's readiness flag. */
export class SceneRuntimeController {
  private programs = new Map<string, SceneRuntimeProgram>();
  private values = new Map<string, SceneRuntimeSnapshot>();
  private listeners = new Set<() => void>();
  private compiled = new Map<string, CompiledSceneRuntime>();
  private preparation = new Map<string, PreparationState>();
  private pending?: { id: string; abort: AbortController };
  private clocks = new Map<string, ReturnType<typeof startRuntimeClock>>();
  private ownedLock?: string;
  private visuals = new Map<string, VisualFrame>();
  private rates = new WeakMap<ScenePackageInstance, number>();
  private sessions = new Map<string, ScenePackageInstance>();
  activeSessionId = () => this.ownedLock;
  visualFrame = (id: string): Readonly<VisualFrame> | undefined =>
    this.visuals.get(id);
  private sceneFor(id: string) {
    return (
      this.sessions.get(id) ??
      useWorkspace.getState().project?.scenePackages?.find((s) => s.id === id)
    );
  }
  getPlaybackRate = (id: string) => {
    const scene = this.sceneFor(id);
    return scene ? (this.rates.get(scene) ?? 1) : 1;
  };
  setPlaybackRate = (id: string, rate: number) => {
    if (
      !Number.isFinite(rate) ||
      rate < MIN_PLAYBACK_RATE ||
      rate > MAX_PLAYBACK_RATE
    )
      throw new Error(
        `播放速度范围为 ${MIN_PLAYBACK_RATE}–${MAX_PLAYBACK_RATE} 倍`,
      );
    const scene = this.sceneFor(id);
    if (!scene) throw new Error("找不到场景");
    if (this.getPlaybackRate(id) === rate) return;
    this.rates.set(scene, rate);
    this.listeners.forEach((f) => f());
  };
  configuration = (id: string) => this.compiled.get(id);
  readiness = (id: string) => this.preparation.get(id);
  async prepare(
    scene: ScenePackageInstance,
    mode: "run" | "validation" = "run",
  ) {
    if (
      this.pending ||
      this.programs.size ||
      useWorkspace.getState().documentLocked
    )
      throw new Error("请先停止并重置当前会话");
    const project = useWorkspace.getState().project;
    if (!project?.scenePackages?.some((s) => s === scene))
      throw new Error("场景不属于当前工程");
    const pending = { id: scene.id, abort: new AbortController() };
    this.pending = pending;
    this.ownedLock = scene.id;
    useWorkspace.setState({ documentLocked: true, activeSceneId: scene.id });
    this.preparation.set(scene.id, { status: "preparing", warnings: [] });
    this.listeners.forEach((f) => f());
    let prepared: Awaited<ReturnType<typeof prepareScenePackage>> | undefined;
    try {
      prepared = await prepareScenePackage(scene, mode, pending.abort.signal);
      if (
        this.pending !== pending ||
        project !== useWorkspace.getState().project
      )
        throw new Error("准备已取消或工程已改变");
      this.compiled.set(scene.id, prepared.compiled);
      this.sessions.set(scene.id, scene);
      this.preparation.set(scene.id, {
        status: "ready",
        warnings: prepared.compiled.readiness.warnings,
      });
      this.attach(prepared.program);
      this.clocks.set(
        scene.id,
        startRuntimeClock(
          () => this.step(scene.id, 1 / 60),
          () => this.programs.get(scene.id)?.needsStep() ?? false,
          () => this.pause(scene.id),
          {
            rate: () => sceneClockRate(this.getPlaybackRate(scene.id)),
            onFrame: (alpha) => {
              const visual = this.visuals.get(scene.id);
              if (visual) visual.alpha = alpha;
            },
          },
        ),
      );
      return prepared.program.runId;
    } catch (e) {
      prepared?.program.dispose();
      if (this.pending === pending) {
        this.preparation.set(scene.id, {
          status: "blocked",
          error: e instanceof Error ? e.message : String(e),
          warnings: [],
        });
        this.unlock(scene.id);
        this.listeners.forEach((f) => f());
      }
      throw e;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }
  cancelPrepare(id: string) {
    if (this.pending?.id !== id) return;
    this.pending.abort.abort();
    this.pending = undefined;
    this.preparation.set(id, {
      status: "blocked",
      error: "准备已取消",
      warnings: [],
    });
    this.unlock(id);
    this.listeners.forEach((f) => f());
  }
  private unlock(id: string) {
    if (this.ownedLock === id) {
      this.ownedLock = undefined;
      useWorkspace.setState({ documentLocked: false });
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = (id: string) => this.values.get(id);
  signalHistory = (id: string, afterSequence = 0) =>
    this.programs.get(id)?.signals.trace(afterSequence);
  private publish(program: SceneRuntimeProgram) {
    const snapshot = program.snapshot();
    this.values.set(program.sceneInstanceId, snapshot);
    this.visuals.set(program.sceneInstanceId, {
      previous: snapshot,
      current: snapshot,
      alpha: 1,
    });
    this.clocks.get(program.sceneInstanceId)?.reset?.();
    this.listeners.forEach((f) => f());
  }
  attach(program: SceneRuntimeProgram) {
    if (this.programs.has(program.sceneInstanceId))
      throw new Error("Scene already has a session");
    this.programs.set(program.sceneInstanceId, program);
    this.publish(program);
  }
  private get(id: string) {
    const p = this.programs.get(id);
    if (!p) throw new Error("Scene has no prepared runtime");
    return p;
  }
  start(id: string) {
    const p = this.get(id);
    p.start();
    this.publish(p);
  }
  step(id: string, dt: number) {
    const p = this.get(id);
    p.advance(dt);
    const next = p.visualSnapshot(),
      last = this.visuals.get(id)?.current;
    const continuous =
      last?.runId === next.runId &&
      last.tick + 1 === next.tick &&
      next.status === last.status &&
      (next.status === "running" || next.status === "stopping");
    this.visuals.set(id, {
      previous: continuous ? last : next,
      current: next,
      alpha: 1,
    });
    const ui = this.values.get(id);
    // About 10 UI updates per second of playback at any speed. State transitions publish immediately.
    if (
      !ui ||
      next.status !== ui.status ||
      next.tick - ui.tick >=
        Math.max(1, Math.round(6 * sceneClockRate(this.getPlaybackRate(id))))
    ) {
      this.values.set(id, p.snapshot());
      this.listeners.forEach((f) => f());
    }
  }
  pause(id: string) {
    const p = this.get(id);
    p.pause();
    this.publish(p);
  }
  resume(id: string) {
    const p = this.get(id);
    p.resume();
    this.publish(p);
  }
  stop(id: string) {
    const p = this.get(id);
    p.stop();
    this.publish(p);
  }
  detach(id: string) {
    const p = this.get(id);
    p.dispose();
    this.clocks.get(id)?.();
    this.clocks.delete(id);
    this.compiled.delete(id);
    this.preparation.delete(id);
    this.unlock(id);
    this.programs.delete(id);
    this.sessions.delete(id);
    this.visuals.delete(id);
    this.values.delete(id);
    this.listeners.forEach((f) => f());
  }
  discard(id: string) {
    const compiled = this.compiled.get(id);
    if (!compiled?.warehouse && !compiled?.loading && !compiled?.handoff)
      throw new Error("当前场景不支持放弃故障仿真");
    this.get(id).discard();
    this.detach(id);
  }
}
export const sceneRuntimeController = new SceneRuntimeController();

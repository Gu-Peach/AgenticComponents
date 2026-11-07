import type {
  SceneRuntimeProgram,
  SceneRuntimeSnapshot,
} from "@/runtime/engine/SceneRuntimeProgram";
import type { ScenePackageInstance } from "@/contracts/scene-package";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import { startRuntimeClock } from "@/runtime/engine/RuntimeClock";
import { useWorkspace } from "@/stores/workspace";
import { prepareScenePackage } from "./prepareScenePackage";
export interface PreparationState {
  status: "preparing" | "ready" | "blocked";
  error?: string;
  warnings: string[];
}
/** Explicitly attaches prepared sessions; never promotes a public bundle's readiness flag. */
export class SceneRuntimeController {
  private programs = new Map<string, SceneRuntimeProgram>();
  private values = new Map<string, SceneRuntimeSnapshot>();
  private listeners = new Set<() => void>();
  private compiled = new Map<string, CompiledSceneRuntime>();
  private preparation = new Map<string, PreparationState>();
  private pending?: { id: string; abort: AbortController };
  private clocks = new Map<string, () => void>();
  private ownedLock?: string;
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
    useWorkspace.setState({ documentLocked: true });
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
        ),
      );
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
    this.values.set(program.sceneInstanceId, program.snapshot());
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
    const next = p.step(dt);
    if (next.tick % 6 === 0 || next.status !== this.values.get(id)?.status)
      this.publish(p);
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
    this.values.delete(id);
    this.listeners.forEach((f) => f());
  }
}
export const sceneRuntimeController = new SceneRuntimeController();

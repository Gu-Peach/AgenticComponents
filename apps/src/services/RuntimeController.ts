import { projectRepository } from "./BrowserProjectRepository";
import type { PhysicsPort } from "@/contracts/physics";
import { emptySnapshot } from "@/runtime/engine/RuntimeSnapshot";
import { SimulationSession } from "@/runtime/engine/SimulationSession";
import { RuntimeKernel } from "@/runtime/engine/RuntimeKernel";
import { startRuntimeClock } from "@/runtime/engine/RuntimeClock";
import { createPhysicsBackend } from "@/runtime/physics/createPhysicsBackend";
import { compileRuntimeScene } from "@/domain/runtime/compileRuntimeScene";
import type { ProjectDocument, DeviceInstance } from "@/contracts/device";
import type { RuntimeSnapshot } from "@/contracts/runtime";
import { useWorkspace } from "@/stores/workspace";
export class RuntimeController {
  private value = emptySnapshot();
  private listeners = new Set<() => void>();
  private session?: SimulationSession;
  private clock?: () => void;
  private generation = 0;
  snapshot = () => this.value;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  isBusy = () =>
    ["preparing", "ready", "running", "paused"].includes(this.value.status);
  private publish(value: RuntimeSnapshot) {
    this.value = value;
    this.listeners.forEach((f) => f());
  }
  async prepare(
    project: ProjectDocument,
    instance: DeviceInstance,
    materialId?: string,
  ) {
    if (useWorkspace.getState().documentLocked)
      throw new Error("请先停止当前预览或仿真");
    const scene = compileRuntimeScene(project, instance.instanceId, materialId);
    this.reset();
    const generation = ++this.generation;
    useWorkspace.setState({ documentLocked: true });
    this.publish({
      ...emptySnapshot(),
      status: "preparing",
      instanceId: instance.instanceId,
    });
    let allocated: PhysicsPort | undefined;
    try {
      const asset = project.definitions.find(
        (d) => d.specId === instance.specId,
      )?.asset.assetId;
      if (!asset || !(await projectRepository.getAsset(asset)))
        throw new Error("传送带模型资源缺失，请重新关联或添加公共模型");
      if (scene.materialInstanceId) {
        const material = project.instances.find(
            (i) => i.instanceId === scene.materialInstanceId,
          ),
          asset = project.definitions.find((d) => d.specId === material?.specId)
            ?.asset.assetId;
        if (!asset || !(await projectRepository.getAsset(asset)))
          throw new Error("物料模型资源缺失");
      }
      const physics = await createPhysicsBackend(scene.physics);
      allocated = physics;
      if (
        generation !== this.generation ||
        useWorkspace.getState().project !== project
      ) {
        physics.dispose();
        if (generation === this.generation) this.reset();
        return;
      }
      this.session = new SimulationSession(new RuntimeKernel(scene, physics));
      this.publish(this.session.snapshot());
      this.session.kernel.tasks.submit(
        `arrival-${generation}`,
        scene.subjectId,
      );
      this.session.kernel.signals.command("runTag", true);
      this.session.start();
      this.publish(this.session.snapshot());
      this.clock = startRuntimeClock(
        (dt) => this.step(dt),
        () => this.value.status === "running",
        () => this.pause(),
      );
    } catch (e) {
      if (!this.session) allocated?.dispose();
      if (generation === this.generation) {
        this.reset();
        this.publish({
          ...emptySnapshot(),
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      throw e;
    }
  }
  step(dt: number) {
    try {
      if (this.session) this.publish(this.session.step(dt));
    } catch (e) {
      this.stop();
      this.publish({ ...this.value, status: "failed", error: String(e) });
    }
  }
  command(id: string, value: boolean | number) {
    if (!this.session || !this.isBusy()) throw new Error("仿真会话未就绪");
    this.session.kernel.signals.command(id, value);
  }
  pause() {
    this.session?.pause();
    if (this.session) this.publish(this.session.snapshot());
  }
  resume() {
    this.session?.resume();
    if (this.session) this.publish(this.session.snapshot());
  }
  stop() {
    ++this.generation;
    this.clock?.();
    this.clock = undefined;
    if (this.session) this.publish(this.session.stop());
    else this.publish({ ...this.value, status: "stopped" });
    useWorkspace.setState({ documentLocked: false });
  }
  reset() {
    this.stop();
    this.session = undefined;
    this.publish(emptySnapshot());
  }
}
export const runtimeController = new RuntimeController();

import {
  compileTransferWorkcell,
  type TransferSelection,
} from "@/domain/runtime/compileTransferWorkcell";
import { MountedSession } from "@/runtime/engine/MountedSession";
import {
  compileMountedWorkcell,
  visibleMountedWorldDevices,
} from "@/domain/runtime/compileMountedWorkcell";
import { TransferSession } from "@/runtime/engine/TransferSession";
import type { RobotCommand } from "@/contracts/robot-command";
import type { RobotExperimentOptions } from "@/domain/runtime/compileRobotExperiment";
import { validateRobotAsset } from "@/domain/runtime/validateRobotAsset";
import { sha256 } from "@/domain/validateGlb";
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
  private ownsDocumentLock = false;
  private value = emptySnapshot();
  private listeners = new Set<() => void>();
  private session?: SimulationSession;
  private transfer?: TransferSession | MountedSession;
  private clock?: () => void;
  private generation = 0;
  snapshot = () => this.value;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  isBusy = () =>
    !!this.transfer ||
    ["preparing", "ready", "running", "paused"].includes(this.value.status);
  private publish(value: RuntimeSnapshot) {
    this.value = value;
    this.listeners.forEach((f) => f());
  }
  async prepare(
    project: ProjectDocument,
    instance: DeviceInstance,
    materialId?: string,
    robotOptions?: RobotExperimentOptions,
  ) {
    if (useWorkspace.getState().documentLocked)
      throw new Error("请先停止当前预览或仿真");
    const scene = compileRuntimeScene(
      project,
      instance.instanceId,
      materialId,
      robotOptions,
    );
    this.reset();
    const generation = ++this.generation;
    this.ownsDocumentLock = true;
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
        throw new Error("设备模型资源缺失，请重新关联或添加公共模型");
      if (scene.materialInstanceId) {
        const material = project.instances.find(
            (i) => i.instanceId === scene.materialInstanceId,
          ),
          asset = project.definitions.find((d) => d.specId === material?.specId)
            ?.asset.assetId;
        if (!asset || !(await projectRepository.getAsset(asset)))
          throw new Error("物料模型资源缺失");
      }
      if (scene.kind === "robot_experiment") {
        const blob = await projectRepository.getAsset(asset);
        const bytes = await blob!.arrayBuffer();
        if ((await sha256(bytes)) !== scene.model.calibration.asset_sha256)
          throw new Error("机械臂模型与校准哈希不符");
        validateRobotAsset(scene, bytes);
      }
      const physics = scene.physics
        ? await createPhysicsBackend(scene.physics)
        : undefined;
      allocated = physics;
      if (
        generation !== this.generation ||
        useWorkspace.getState().project !== project
      ) {
        physics?.dispose();
        if (generation === this.generation) this.reset();
        return;
      }
      this.session = new SimulationSession(new RuntimeKernel(scene, physics));
      this.publish(this.session.snapshot());
      if (scene.kind !== "robot_experiment") {
        this.session.kernel.tasks.submit(
          `arrival-${generation}`,
          scene.subjectId,
        );
        this.session.kernel.signals.command("runTag", true);
      }
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
  /** 多台独立模型共享同一世界、工艺调度器和工作区锁。 */
  async prepareTransfer(
    project: ProjectDocument,
    selection: TransferSelection,
    ir?: unknown,
  ) {
    if (useWorkspace.getState().documentLocked)
      throw new Error("请先停止当前仿真");
    const compiled = compileTransferWorkcell(project, selection, ir);
    return this.prepareWorkcell(project, selection.robot, async () => {
      for (const id of new Set(Object.values(selection))) {
        const spec = project.instances.find((i) => i.instanceId === id)!.specId;
        const definition = project.definitions.find((d) => d.specId === spec)!;
        const blob =
          definition.asset.assetId &&
          (await projectRepository.getAsset(definition.asset.assetId));
        if (!blob) throw new Error("组合设备缺少模型资源：" + id);
        const bytes = await blob.arrayBuffer();
        const hash = await sha256(bytes);
        if (definition.asset.sha256 && hash !== definition.asset.sha256)
          throw new Error("设备模型哈希不符：" + id);
        if (id === selection.robot) {
          if (hash !== compiled.robot.model.calibration.asset_sha256)
            throw new Error("机械臂模型与标定不匹配");
          validateRobotAsset(compiled.robot, bytes);
        }
      }
      const { assembleTransferWorkcell } =
        await import("@/runtime/assembly/TransferWorkcell");
      const program = await assembleTransferWorkcell(
        compiled,
        project.id,
        crypto.randomUUID(),
      );
      return new TransferSession(compiled, program);
    });
  }
  async prepareMounted(project: ProjectDocument, rail: string, ir: unknown) {
    return this.prepareWorkcell(project, rail, async () => {
      const assets = new Map<string, ArrayBuffer>();
      for (const i of visibleMountedWorldDevices(project)) {
        const id = i.instanceId;
        const d = project.definitions.find(
          (v) => v.specId === i?.specId && v.revision === i?.specRevision,
        );
        const blob =
          d?.asset.assetId &&
          (await projectRepository.getAsset(d.asset.assetId));
        if (!blob)
          throw new Error(
            "可见设备模型缺失，无法校验运动净空：" +
              id +
              "。请关联 GLB、隐藏该实例或在空项目中装配。",
          );
        const bytes = await blob.arrayBuffer();
        if (d.asset.sha256 && (await sha256(bytes)) !== d.asset.sha256)
          throw new Error("挂载设备模型哈希不符：" + id);
        assets.set(id, bytes);
      }
      const c = compileMountedWorkcell(project, rail, assets, ir);
      const { assembleMountedWorkcell } =
        await import("@/runtime/assembly/MountedWorkcell");
      return new MountedSession(
        rail,
        await assembleMountedWorkcell(c, project.id, crypto.randomUUID()),
      );
    });
  }
  private async prepareWorkcell(
    project: ProjectDocument,
    instanceId: string,
    create: () => Promise<TransferSession | MountedSession>,
  ) {
    if (useWorkspace.getState().documentLocked)
      throw new Error("请先停止当前仿真");
    this.reset();
    const generation = ++this.generation;
    this.ownsDocumentLock = true;
    useWorkspace.setState({ documentLocked: true });
    this.publish({
      ...emptySnapshot(),
      status: "preparing",
      instanceId,
    });
    const stale = () =>
      generation !== this.generation ||
      useWorkspace.getState().project !== project;
    try {
      const session = await create();
      if (stale()) {
        session.program.dispose();
        if (generation === this.generation) this.reset();
        return;
      }
      this.transfer = session;
      const program = session.program;
      program.start();
      this.publish(this.transfer.snapshot());
      this.clock = startRuntimeClock(
        (dt) => this.step(dt),
        () => program.needsStep(),
        () => this.pause(),
      );
    } catch (e) {
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
      if (this.transfer) {
        this.transfer.program.advance(dt);
        this.publish(this.transfer.snapshot());
        if (
          !this.transfer.program.needsStep() &&
          this.value.status !== "paused"
        ) {
          this.clock?.();
          this.clock = undefined;
        }
      } else if (this.session) this.publish(this.session.step(dt));
    } catch (e) {
      this.stop();
      this.publish({ ...this.value, status: "failed", error: String(e) });
    }
  }
  command(id: string, value: boolean | number) {
    if (!this.session || !this.isBusy()) throw new Error("仿真会话未就绪");
    this.session.kernel.command(id, value);
  }
  submitAction(command: RobotCommand) {
    if (!this.session || !this.isBusy()) throw new Error("会话未准备");
    this.session.kernel.submitAction(command);
    this.publish(this.session.snapshot());
  }
  pickAndPlace(requestId: number, grasp?: string) {
    if (!this.session || !this.isBusy()) throw new Error("会话未准备");
    this.submitAction(this.session.kernel.pickPlaceCommand(requestId, grasp));
  }
  pause() {
    if (this.transfer) {
      this.transfer.program.pause();
      this.publish(this.transfer.snapshot());
      return;
    }
    this.session?.pause();
    if (this.session) this.publish(this.session.snapshot());
  }
  resume() {
    if (this.transfer) {
      this.transfer.program.resume();
      this.publish(this.transfer.snapshot());
      return;
    }
    this.session?.resume();
    if (this.session) this.publish(this.session.snapshot());
  }
  stop() {
    if (this.transfer) {
      const p = this.transfer.program;
      if (p.needsStep() || p.visualSnapshot().status === "paused") p.stop();
      this.publish(this.transfer.snapshot());
      return;
    }
    ++this.generation;
    this.clock?.();
    this.clock = undefined;
    if (this.session) this.publish(this.session.stop());
    else this.publish({ ...this.value, status: "stopped" });
    if (this.ownsDocumentLock) {
      this.ownsDocumentLock = false;
      useWorkspace.setState({ documentLocked: false });
    }
  }
  reset() {
    if (this.transfer) {
      this.transfer.reset();
      this.transfer = undefined;
    }
    this.stop();
    this.session = undefined;
    this.publish(emptySnapshot());
  }
}
export const runtimeController = new RuntimeController();

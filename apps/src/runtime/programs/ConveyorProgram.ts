import type {
  CompiledRuntimeScene,
  RuntimeSnapshot,
} from "@/contracts/runtime";
import type { PhysicsPort } from "@/contracts/physics";
import { SignalRegistry } from "../engine/SignalRegistry";
import { ActionGateway } from "../engine/ActionGateway";
import { RunOwnership } from "../engine/RunOwnership";
import { observeRegions } from "../engine/RegionObserver";
import { registerTemplates } from "@/runtime/templates/registerTemplates";
export class ConveyorProgram {
  readonly signals = new SignalRegistry();
  readonly tasks: ActionGateway;
  private owners = new RunOwnership();
  private script;
  private tick = 0;
  private disposed = false;
  private speed = 0;
  private arrivalStopped = false;
  private current: RuntimeSnapshot;
  constructor(
    readonly scene: CompiledRuntimeScene,
    private physics: PhysicsPort,
  ) {
    this.tasks = new ActionGateway(scene.subjectId);
    this.owners.claim(scene.instanceId);
    this.owners.claim(scene.subjectId);
    this.script = registerTemplates().get(scene.templateId).create(scene);
    this.signals.command("runTag", false);
    this.signals.command("speedTag", scene.speed);
    this.signals.begin(0);
    this.current = {
      status: "ready",
      tick: 0,
      time: 0,
      instanceId: scene.instanceId,
      subjectId: scene.subjectId,
      pose: physics.readMaterial(),
      size: scene.physics.materialSize,
      materialInstanceId: scene.materialInstanceId,
      bodyLocalMatrix: scene.bodyLocalMatrix,
      signals: this.signals.snapshot(),
      supported: false,
      atExit: false,
      request: null,
    };
  }
  step(dt: number) {
    if (this.disposed) throw new Error("会话已结束");
    if (!Number.isFinite(dt) || Math.abs(dt - 1 / 60) > 1e-8)
      throw new Error("只接受固定 1/60 秒逻辑步");
    this.tick++;
    this.signals.begin(this.tick);
    const observedPhysics = {
      setSurfaceSpeed: (s: number) => {
        this.speed = s;
        this.physics.setSurfaceSpeed(s);
      },
    };
    this.script.beforePhysics(dt, this.signals, observedPhysics);
    this.physics.step(dt);
    const pose = this.physics.readMaterial(),
      supported = this.physics.hasSupport(),
      region = observeRegions(this.scene, pose, supported);
    this.tasks.observe(
      this.tick,
      supported,
      region.atExit,
      region.fallen,
      this.scene.timeout,
    );
    if (this.tasks.request?.status === "succeeded" && !this.arrivalStopped) {
      this.signals.command("runTag", false);
      this.arrivalStopped = true;
    }
    this.script.afterPhysics({
      dt,
      tick: this.tick,
      appliedSpeed: this.speed,
      support: supported,
      atExit: region.atExit,
      entryClear: region.entryClear,
      request: this.tasks.request,
      publish: (id, value) => this.signals.publish(id, value, this.tick),
    });
    this.current = {
      ...this.current,
      status: "running",
      tick: this.tick,
      time: this.tick * dt,
      pose,
      supported,
      atExit: region.atExit,
      signals: this.signals.snapshot(),
      request: this.tasks.request ? { ...this.tasks.request } : null,
    };
    return this.snapshot();
  }
  snapshot() {
    return structuredClone(this.current);
  }
  stop() {
    if (this.disposed) return this.snapshot();
    this.disposed = true;
    this.tasks.cancel();
    this.current = {
      ...this.current,
      status: "stopped",
      request: this.tasks.request ? { ...this.tasks.request } : null,
    };
    this.signals.publish("busy", false, this.tick);
    this.current.signals = this.signals.snapshot();
    this.physics.setSurfaceSpeed(0);
    this.script.dispose();
    this.physics.dispose();
    this.owners.clear();
    return this.snapshot();
  }
}

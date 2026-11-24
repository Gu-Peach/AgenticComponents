import { Quaternion, Vector3 } from "three";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import type { ActionRequest } from "@/contracts/scheduler";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import { HandoffArm } from "./HandoffMotion";
import { HumanCarryMotion } from "../mechanisms/HumanCarryMotion";
import { RotaryIndexMotion } from "../mechanisms/RotaryIndexMotion";
import {
  RobotProcessingMotion,
  type ProcessEvidence,
} from "../mechanisms/RobotProcessingMotion";

function isStable(p: BodyPose) {
  return (
    Math.hypot(...p.velocity) < 0.025 &&
    Math.hypot(...(p.angularVelocity ?? [])) < 0.08
  );
}

export class IndexingCellMotion {
  private readonly config;
  private readonly human;
  private readonly table;
  private readonly robot;
  private readonly tolerance: number;
  private tableMaterial: string | null = null;
  private transfers: {
    material: string;
    source: string;
    target: string;
    tick: number;
    request: string;
  }[] = [];
  private rotations: {
    material: string;
    fromDeg: number;
    toDeg: number;
    measuredAngleDeg: number;
    tick: number;
    request: string;
  }[] = [];
  private operations: ({
    material: string;
    robot: string;
    recipe: string;
    station: string;
    tool: string;
    process: string;
    tick: number;
    request: string;
  } & ProcessEvidence)[] = [];

  constructor(
    private compiled: CompiledSceneRuntime,
    private physics: PhysicsPort,
  ) {
    const c = (this.config = compiled.indexedProcessing!);
    const parameter = (id: string, key: string) => {
      const value = compiled.devices.get(id)?.parameters[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        throw new Error("Invalid indexed cell parameter " + id + "." + key);
      return value;
    };
    this.tolerance = parameter(c.human, "position_tolerance_m");
    this.human = new HumanCarryMotion(
      physics,
      c.humanBody,
      c.handBody,
      parameter(c.human, "travel_speed_mps"),
      parameter(c.human, "lift_height_m"),
      this.tolerance,
    );
    this.table = new RotaryIndexMotion(
      physics,
      c.tableBody,
      c.pivot,
      c.axis,
      parameter(c.table, "rotate_speed_deg_s"),
      parameter(c.table, "rotate_accel_deg_s2"),
      parameter(c.table, "angle_tolerance_deg"),
      parameter(c.table, "settle_speed_deg_s"),
    );
    this.robot = new RobotProcessingMotion(
      new HandoffArm(compiled.robots.get(c.robot)!, c.toolAxis, physics),
      parameter(c.robot, "process_time_s"),
      parameter(c.robot, "process_position_tolerance_m"),
      parameter(c.robot, "process_angle_tolerance_deg"),
    );
  }
  private task(id: string) {
    return this.config.jobs.find((j) => j.material === id);
  }
  private finished(id: string) {
    return this.operations.some((op) => op.material === id);
  }
  private body(id: string) {
    return this.compiled.bodyMap.get(id + "/body")!;
  }
  private port(id: string, kind: "grasp" | "process") {
    const f = this.config.materialFrames.get(id)![kind];
    const p = this.physics.readBody!(this.body(id).id),
      q = new Quaternion(...p.rotation);
    return {
      position: new Vector3(...f.offset)
        .applyQuaternion(q)
        .add(new Vector3(...p.position)),
      outward: new Vector3(...f.outward).applyQuaternion(q).normalize(),
    };
  }
  private center(id: string, location: string) {
    const c = this.config;
    const bottom =
      location === c.slot
        ? this.table.slot(c.slotOffset)
        : new Vector3(
            ...this.compiled.devices.get(c.source)!.locations[location]
              .position,
          );
    return bottom.add(new Vector3(0, this.body(id).size[1] / 2, 0));
  }
  private on(id: string, location: string, allowCarry = true) {
    const b = this.body(id);
    if (
      !b ||
      !this.physics.isBodyActive!(b.id) ||
      this.physics.hasGraspForBody!(b.id)
    )
      return false;
    const p = this.physics.readBody!(b.id);
    const isTable = location === this.config.slot;
    const support = isTable ? this.config.tableBody : this.config.sourceBody;
    return (
      (this.physics.hasContactSupport!(b.id, support) ||
        (isTable && allowCarry && this.physics.isCarriedBy!(b.id, support))) &&
      isStable(p) &&
      new Vector3(...p.position).distanceTo(this.center(id, location)) <=
        this.tolerance
    );
  }
  private retained(id: string) {
    const b = this.body(id);
    if (
      this.tableMaterial !== id ||
      !this.physics.isCarriedBy!(b.id, this.config.tableBody)
    )
      return false;
    const p = this.physics.readBody!(b.id);
    const expected = new Quaternion()
      .setFromAxisAngle(
        new Vector3(...this.config.axis),
        (this.table.angleDeg * Math.PI) / 180,
      )
      .multiply(new Quaternion(...b.rotation));
    return (
      expected.angleTo(new Quaternion(...p.rotation)) <= 0.065 &&
      new Vector3(...p.position).distanceTo(
        this.center(id, this.config.slot),
      ) <= 0.025
    );
  }
  private fields(r: ActionRequest) {
    const p = r.payload as
      { binding?: string; fields?: Record<string, string> } | undefined;
    return p?.binding === r.device + "." + r.behavior ? p.fields : undefined;
  }
  private angle(r: ActionRequest) {
    const quantity = r.arguments.angleTag as
      { value?: number; unit?: string } | undefined;
    return quantity?.unit === "°" ? quantity.value : undefined;
  }
  ready(r: ActionRequest) {
    const c = this.config;
    if (r.device === c.table && r.behavior === "rotate_to_station") {
      const id = this.tableMaterial,
        target = this.angle(r);
      return (
        !!id &&
        this.human.atHome &&
        this.robot.arm.atHome &&
        this.retained(id) &&
        ((target === 180 && this.table.at(0) && !this.finished(id)) ||
          (target === 0 && this.table.at(180) && this.finished(id)))
      );
    }
    const f = this.fields(r),
      id = f?.material;
    if (
      !f ||
      !id ||
      !this.task(id) ||
      !this.physics.isBodyActive!(this.body(id).id)
    )
      return false;
    const frames = c.materialFrames.get(id)!,
      task = this.task(id)!;
    if (r.device === c.robot && r.behavior === "process_material") {
      return (
        this.human.atHome &&
        this.robot.arm.atHome &&
        this.table.at(180) &&
        this.retained(id) &&
        !this.finished(id) &&
        f.tool === c.toolInterface &&
        f.process === frames.processInterface &&
        f.station === c.slot
      );
    }
    if (r.device === c.human && r.behavior === "carry_material") {
      return (
        this.human.atHome &&
        this.robot.arm.atHome &&
        this.table.at(0) &&
        f.grasp === frames.graspInterface &&
        ((f.source === task.input &&
          f.target === c.slot &&
          !this.tableMaterial &&
          !this.finished(id) &&
          this.on(id, f.source)) ||
          (f.source === c.slot &&
            f.target === task.target &&
            this.finished(id) &&
            this.retained(id) &&
            this.on(id, f.source)))
      );
    }
    return false;
  }
  job(r: ActionRequest) {
    if (!this.ready(r))
      throw new Error(
        "Indexed action lacks physical admission: " +
          r.device +
          "." +
          r.behavior,
      );
    const c = this.config,
      f = this.fields(r);
    if (r.device === c.table) {
      const material = this.tableMaterial!;
      return this.table.job(
        this.angle(r)!,
        () =>
          this.human.atHome && this.robot.arm.atHome && this.retained(material),
        (tick, fromDeg, toDeg) =>
          this.rotations.push({
            material,
            fromDeg,
            toDeg,
            measuredAngleDeg: this.table.measuredAngleDeg,
            tick,
            request: r.requestId,
          }),
      );
    }
    const { material, source, target } = f!;
    if (r.device === c.robot)
      return this.robot.job(
        () => this.port(material, "process"),
        () =>
          this.human.atHome && this.table.at(180) && this.retained(material),
        (tick, evidence) =>
          this.operations.push({
            material,
            robot: r.device,
            recipe: c.recipe,
            station: f!.station,
            tool: f!.tool,
            process: f!.process,
            request: r.requestId,
            tick,
            ...evidence,
          }),
      );
    const body = this.body(material),
      pickup = () => this.port(material, "grasp").position;
    const loading = target === c.slot;
    return this.human.job({
      material,
      body: body.id,
      source: pickup,
      destination: this.center(material, target),
      handleOffset: pickup().sub(
        new Vector3(...this.physics.readBody!(body.id).position),
      ),
      sourceReady: () =>
        this.table.at(0) && this.robot.arm.atHome && this.on(material, source),
      captured: () => {
        if (!loading) this.tableMaterial = null;
      },
      receiverReady: () =>
        this.table.at(0) && this.robot.arm.atHome && !this.tableMaterial,
      placed: () => this.on(material, target),
      accept: () => {
        if (loading) {
          if (!this.on(material, target, false))
            throw new Error("Placement lacks physical table contact");
          this.physics.bindLoad!(c.tableBody, body.id);
          this.tableMaterial = material;
        }
      },
      complete: (tick) =>
        this.transfers.push({
          material,
          source,
          target,
          tick,
          request: r.requestId,
        }),
    });
  }
  stopped(id: string) {
    return id === this.config.robot
      ? this.robot.arm.stopped
      : id === this.config.table
        ? this.table.stopped
        : id === this.config.human && this.human.stopped && !this.human.holding;
  }
  snapshot() {
    const c = this.config;
    return {
      angleDeg: this.table.angleDeg,
      measuredAngleDeg: this.table.measuredAngleDeg,
      humanHome: this.human.atHome,
      robotHome: this.robot.arm.atHome,
      holding: this.human.holding,
      tableMaterial: this.tableMaterial,
      phase: {
        [c.human]: this.human.phase,
        [c.table]: this.table.phase,
        [c.robot]: this.robot.phase,
      },
      stopped: {
        [c.human]: this.stopped(c.human),
        [c.table]: this.stopped(c.table),
        [c.robot]: this.stopped(c.robot),
      },
      transfers: [...this.transfers],
      rotations: [...this.rotations],
      operations: [...this.operations],
      alignment: this.robot.alignment,
      q: [...this.robot.arm.q],
      qdot: [...this.robot.arm.qdot],
    };
  }
}

/** 将已装配的工装、物料与设备行为绑定，按请求读取端点和实测约束并保留完成回执。 */
import { getDeviceModule } from "@/devices/registry";
import { Quaternion, Vector3 } from "three";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import type { ActionRequest } from "@/contracts/scheduler";
import type { CompiledSceneRuntime } from "@/contracts/scene-execution";
import type { ProcessEvidence } from "@/devices/robot_arm/behavior";

function isStable(p: BodyPose) {
  return (
    Math.hypot(...p.velocity) < 0.025 &&
    Math.hypot(...(p.angularVelocity ?? [])) < 0.08
  );
}

export function requestFields(r: ActionRequest): Record<string, string> {
  return (
    (r.payload as { fields?: Record<string, string> } | undefined)?.fields ?? {}
  );
}

export class IndexedFixtureBindings {
  private readonly config;
  private readonly human;
  private readonly table;
  private readonly robot;
  private readonly tolerance: number;
  private tableMaterial: string | null = null;
  private boundOrientation?: Quaternion;
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
    this.human = getDeviceModule("human_operator").createMotion(
      physics,
      c.humanBody,
      c.handBody,
      parameter(c.human, "travel_speed_mps"),
      parameter(c.human, "lift_height_m"),
      this.tolerance,
    );
    this.table = getDeviceModule("rotary_table").createMotion(
      physics,
      c.tableBody,
      c.pivot,
      c.axis,
      parameter(c.table, "rotate_speed_deg_s"),
      parameter(c.table, "rotate_accel_deg_s2"),
      parameter(c.table, "angle_tolerance_deg"),
      parameter(c.table, "settle_speed_deg_s"),
      c.indexing.home,
    );
    this.robot = getDeviceModule("robot_arm").createProcessingMotion(
      getDeviceModule("robot_arm").createArticulatedArm(
        compiled.robots.get(c.robot)!,
        c.toolAxis,
        physics,
      ),
      parameter(c.robot, "process_time_s"),
      parameter(c.robot, "process_position_tolerance_m"),
      parameter(c.robot, "process_angle_tolerance_deg"),
    );
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
  supportedAt(id: string, location: string, allowCarry = true) {
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
    const rotor = this.physics.readBody!(this.config.tableBody);
    const expected = new Quaternion(...rotor.rotation).multiply(
      this.boundOrientation!,
    );
    return (
      expected.angleTo(new Quaternion(...p.rotation)) <= 0.065 &&
      new Vector3(...p.position).distanceTo(
        this.center(id, this.config.slot),
      ) <= 0.025
    );
  }
  index(r: ActionRequest) {
    const { value, unit } = r.arguments.angleTag as {
      value: number;
      unit: string;
    };
    const material = this.tableMaterial;
    if (unit !== "°" || !this.config.indexing.stations.includes(value))
      throw new Error("Indexing request requires a configured station");
    if (
      !material ||
      !this.table.stopped ||
      !this.human.atHome ||
      !this.robot.arm.atHome ||
      !this.retained(material)
    )
      throw new Error("Indexing requires a secured load and cleared work area");
    return this.table.job(
      value,
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
  process(r: ActionRequest) {
    const c = this.config;
    const { material, tool, process, station } = requestFields(r);
    if (
      !this.robot.arm.atHome ||
      !this.human.atHome ||
      !this.table.at(c.indexing.process) ||
      !this.retained(material) ||
      this.operations.some((op) => op.material === material)
    )
      throw new Error(
        "Processing requires a secured raw workpiece at the tool dock",
      );
    return this.robot.job(
      () => this.port(material, "process"),
      () =>
        this.human.atHome &&
        this.table.at(c.indexing.process) &&
        this.retained(material),
      (tick, evidence) =>
        this.operations.push({
          material,
          robot: r.device,
          recipe: c.recipe,
          station,
          tool,
          process,
          request: r.requestId,
          tick,
          ...evidence,
        }),
    );
  }
  carry(r: ActionRequest) {
    const c = this.config;
    const { material, source, target } = requestFields(r);
    if (
      !this.human.atHome ||
      !this.robot.arm.atHome ||
      !this.table.at(c.indexing.home) ||
      !this.supportedAt(material, source) ||
      (target === c.slot && this.tableMaterial) ||
      (source === c.slot && !this.retained(material))
    )
      throw new Error(
        "Carry requires the specified workpiece and an available dock",
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
        this.table.at(c.indexing.home) &&
        this.robot.arm.atHome &&
        this.supportedAt(material, source),
      captured: () => {
        if (source === c.slot) {
          this.tableMaterial = null;
          this.boundOrientation = undefined;
        }
      },
      receiverReady: () =>
        this.table.at(c.indexing.home) &&
        this.robot.arm.atHome &&
        !this.tableMaterial,
      placed: () => this.supportedAt(material, target),
      accept: () => {
        if (loading) {
          if (!this.supportedAt(material, target, false))
            throw new Error("Placement lacks physical table contact");
          this.physics.bindLoad!(c.tableBody, body.id);
          this.tableMaterial = material;
          this.boundOrientation = new Quaternion(
            ...this.physics.readBody!(c.tableBody).rotation,
          )
            .invert()
            .multiply(
              new Quaternion(...this.physics.readBody!(body.id).rotation),
            );
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
      retained: !!this.tableMaterial && this.retained(this.tableMaterial),
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

import { moveTool } from "./KinematicToolDriver";
import { GraspConstraints } from "./GraspConstraints";
import { BodyRegistry } from "./BodyRegistry";
import { ConveyorContacts } from "./ConveyorContacts";
import type { RuntimeBody, RuntimeSurface } from "@/contracts/physics";
import initJolt from "jolt-physics";
import type Jolt from "jolt-physics";
import type { PhysicsConfig, PhysicsPort, BodyPose } from "@/contracts/physics";
type Module = Awaited<ReturnType<typeof initJolt>>;
let modulePromise: Promise<Module> | undefined;
export async function createJoltBackend(
  config: PhysicsConfig,
): Promise<PhysicsPort> {
  modulePromise ??= initJolt();
  return new JoltPhysicsBackend(await modulePromise, config);
}
class JoltPhysicsBackend implements PhysicsPort {
  private world: Jolt.JoltInterface;
  private system: Jolt.PhysicsSystem;
  private bi: Jolt.BodyInterface;
  private registry = new BodyRegistry();
  private contacts: ConveyorContacts;
  private grasps?: GraspConstraints;
  private targetId: string;
  private disposed = false;
  constructor(
    private J: Module,
    private config: PhysicsConfig,
  ) {
    const settings = new J.JoltSettings(),
      pairs = new J.ObjectLayerPairFilterTable(2);
    pairs.EnableCollision(0, 1);
    pairs.EnableCollision(1, 1);
    const broad = new J.BroadPhaseLayerInterfaceTable(2, 2);
    for (let i = 0; i < 2; i++) {
      const layer = new J.BroadPhaseLayer(i);
      broad.MapObjectToBroadPhaseLayer(i, layer);
      J.destroy(layer);
    }
    settings.mObjectLayerPairFilter = pairs;
    settings.mBroadPhaseLayerInterface = broad;
    settings.mObjectVsBroadPhaseLayerFilter =
      new J.ObjectVsBroadPhaseLayerFilterTable(broad, 2, pairs, 2);
    this.world = new J.JoltInterface(settings);
    J.destroy(settings);
    this.system = this.world.GetPhysicsSystem();
    this.bi = this.system.GetBodyInterface();
    const ps = this.system.GetPhysicsSettings();
    ps.mPenetrationSlop = 0.001;
    // Millimetre-scale pallet rails must not collide with a downstream edge centimetres early.
    if (config.bodies?.some((b) => b.convexParts))
      ps.mSpeculativeContactDistance = 0.002;
    if (config.carrierBindings?.length) ps.mNumVelocitySteps = 40;

    this.system.SetPhysicsSettings(ps);
    const q = config.rotation,
      flow: [number, number, number] = [
        1 - 2 * (q[1] * q[1] + q[2] * q[2]),
        0,
        2 * (q[0] * q[2] - q[1] * q[3]),
      ];
    const legacy = (
      id: string,
      position: RuntimeBody["position"],
      size: RuntimeBody["size"],
      dynamic = false,
    ): RuntimeBody => ({
      id,
      instanceId: id,
      motionType: dynamic ? "dynamic" : "static",
      role: dynamic
        ? "material"
        : id === "belt"
          ? "conveying_support"
          : "ground",
      position,
      rotation: q,
      size,
      mass: dynamic ? config.mass : undefined,
      friction: config.friction,
      restitution: 0,
    });
    const definitions = config.bodies ?? [
      legacy("belt", config.surfacePosition, config.surfaceSize),
      legacy(
        "ground",
        [config.surfacePosition[0], -0.05, config.surfacePosition[2]],
        [20, 0.1, 20],
      ),
      legacy("material", config.materialPosition, config.materialSize, true),
      ...(config.obstacle
        ? [
            legacy(
              "obstacle",
              [
                config.surfacePosition[0] + 0.1,
                config.surfacePosition[1] + 0.16,
                config.surfacePosition[2],
              ],
              [0.04, 0.25, 0.5],
            ),
          ]
        : []),
    ];
    const surfaces: RuntimeSurface[] = config.surfaces ?? [
      { id: "main_belt", bodyId: "belt", direction: flow, normal: [0, 1, 0] },
    ];
    this.targetId = config.targetBodyId ?? "material";
    try {
      if (new Set(definitions.map((d) => d.id)).size !== definitions.length)
        throw new Error("重复刚体 ID");
      for (const d of definitions) {
        if (
          [
            ...d.position,
            ...d.rotation,
            ...d.size,
            d.friction,
            d.restitution,
          ].some((n) => !Number.isFinite(n)) ||
          d.friction < 0 ||
          d.restitution < 0 ||
          d.restitution > 1 ||
          Math.abs(Math.hypot(...d.rotation) - 1) > 1e-5
        )
          throw new Error("刚体位姿或接触参数无效");
        if (
          d.motionType === "kinematic" &&
          !["tool", "support", "carrier"].includes(d.role)
        )
          throw new Error("不支持的运动学刚体角色");
        if (
          d.size.some((n) => !Number.isFinite(n) || n <= 0) ||
          (d.motionType === "dynamic" && (!d.mass || d.mass <= 0))
        )
          throw new Error("刚体尺寸或质量无效");
        this.box(d);
      }
      for (const surface of surfaces) {
        if (
          this.registry.get(surface.bodyId).definition.role !==
          "conveying_support"
        )
          throw new Error("输送面角色不匹配");
        if (
          Math.abs(Math.hypot(...surface.direction) - 1) > 1e-5 ||
          Math.abs(Math.hypot(...surface.normal) - 1) > 1e-5 ||
          Math.abs(
            surface.direction.reduce((v, n, i) => v + n * surface.normal[i], 0),
          ) > 1e-5
        )
          throw new Error("输送方向/法向无效");
      }
      this.registry.get(this.targetId);
      if (
        definitions.some((d) => d.role === "tool") ||
        config.carrierBindings?.length
      )
        this.grasps = new GraspConstraints(
          J,
          this.system,
          this.bi,
          this.registry,
        );
      this.bindActiveCarriers();
      this.contacts = new ConveyorContacts(J, this.registry, surfaces);
      this.system.SetContactListener(this.contacts.listener);
    } catch (e) {
      this.grasps?.dispose();
      for (const { body, active } of this.registry.values()) {
        if (active) this.bi.RemoveBody(body.GetID());
        this.bi.DestroyBody(body.GetID());
      }
      this.registry.clear();
      this.grasps?.releaseFilter();
      J.destroy(this.world);
      throw e;
    }
  }

  private box(d: RuntimeBody) {
    const position = d.position,
      size = d.size,
      dynamic = d.motionType === "dynamic";
    const J = this.J;
    let shape: Jolt.Shape;
    const keepAlive: Jolt.ShapeResult[] = [];
    try {
      if (d.convexParts) {
        if (!d.convexParts.length || d.convexParts.length > 256)
          throw new Error("Invalid convex parts");
        const compound = new J.StaticCompoundShapeSettings(),
          zero = new J.Vec3(0, 0, 0),
          identity = new J.Quat(0, 0, 0, 1);
        try {
          for (const [index, points] of d.convexParts.entries()) {
            if (
              points.length < 4 ||
              points.some((p) => p.length !== 3 || !p.every(Number.isFinite))
            )
              throw new Error("Invalid hull points");
            const hull = new J.ConvexHullShapeSettings();
            hull.mMaxConvexRadius = 0.001;
            for (const point of points) {
              const v = new J.Vec3(...point);
              hull.mPoints.push_back(v);
              J.destroy(v);
            }
            const result = hull.Create();
            J.destroy(hull);
            keepAlive.push(result);
            if (result.HasError())
              throw new Error(
                "Hull creation failed: " + result.GetError().c_str(),
              );
            compound.AddShapeShape(zero, identity, result.Get(), index);
          }
          const result = compound.Create();
          keepAlive.push(result);
          if (result.HasError())
            throw new Error(
              "Compound creation failed: " + result.GetError().c_str(),
            );
          shape = result.Get();
        } finally {
          J.destroy(compound);
          J.destroy(zero);
          J.destroy(identity);
        }
      } else {
        const half = new J.Vec3(size[0] / 2, size[1] / 2, size[2] / 2);
        shape = new J.BoxShape(half, 0.001);
        J.destroy(half);
      }
      const pos = new J.RVec3(...(position as [number, number, number])),
        q = new J.Quat(...d.rotation),
        settings = new J.BodyCreationSettings(
          shape,
          pos,
          q,
          dynamic
            ? J.EMotionType_Dynamic
            : d.motionType === "kinematic"
              ? J.EMotionType_Kinematic
              : J.EMotionType_Static,
          d.motionType !== "static" ? 1 : 0,
        );
      settings.mFriction = d.friction;
      settings.mIsSensor = d.sensor ?? false;
      settings.mRestitution = d.restitution;
      settings.mLinearDamping = 0;
      settings.mAllowSleeping = false;
      if (dynamic) {
        settings.mOverrideMassProperties =
          J.EOverrideMassProperties_CalculateInertia;
        settings.mMassPropertiesOverride.mMass = d.mass!;
      }
      const body = this.bi.CreateBody(settings);

      if (d.initiallyActive !== false)
        this.bi.AddBody(body.GetID(), J.EActivation_Activate);
      this.registry.add(d, body);
      J.destroy(pos);
      J.destroy(q);
      J.destroy(settings);
      return body;
    } finally {
      for (const result of keepAlive) J.destroy(result);
    }
  }
  setSurfaceSpeed(speed: number) {
    if (!Number.isFinite(speed)) throw new Error("表面速度必须有限");
    if (this.disposed) throw new Error("物理世界已释放");
    this.contacts.setSpeed(speed);
  }
  setSurfaceSpeeds(speeds: Readonly<Record<string, number>>) {
    if (this.disposed) throw new Error("World disposed");
    this.contacts.setSpeeds(speeds);
  }
  getSurfaceSpeed(id: string) {
    if (this.disposed) throw new Error("World disposed");
    return this.contacts.getSpeed(id);
  }
  isBodyActive(id: string) {
    return !this.disposed && this.registry.get(id).active;
  }
  hasGraspForBody(id: string) {
    return this.grasps?.involves(id) ?? false;
  }
  isCarriedBy(material: string, carrier?: string) {
    return this.grasps?.isCarriedBy(material, carrier) ?? false;
  }
  private bindActiveCarriers() {
    for (const { carrier, material } of this.config.carrierBindings ?? []) {
      if (
        this.registry.get(carrier).active &&
        this.registry.get(material).active &&
        !this.isCarriedBy(material)
      )
        this.grasps!.carry(carrier, material);
    }
  }
  activateBodies(placements: readonly { id: string; pose: BodyPose }[]) {
    if (this.disposed) throw new Error("World disposed");
    if (new Set(placements.map((p) => p.id)).size !== placements.length)
      throw new Error("Duplicate activation");
    for (const { id, pose } of placements) {
      const r = this.registry.get(id);
      if (
        r.active ||
        r.definition.motionType !== "dynamic" ||
        ![...pose.position, ...pose.rotation, ...pose.velocity].every(
          Number.isFinite,
        ) ||
        Math.abs(Math.hypot(...pose.rotation) - 1) > 1e-5
      )
        throw new Error("Invalid body admission");
    }
    for (const { id, pose } of placements) {
      const r = this.registry.get(id),
        p = new this.J.RVec3(...pose.position),
        q = new this.J.Quat(...pose.rotation),
        v = new this.J.Vec3(...pose.velocity),
        w = new this.J.Vec3(0, 0, 0);
      try {
        this.bi.SetPositionAndRotation(
          r.body.GetID(),
          p,
          q,
          this.J.EActivation_DontActivate,
        );
        this.bi.SetLinearAndAngularVelocity(r.body.GetID(), v, w);
        this.bi.AddBody(r.body.GetID(), this.J.EActivation_Activate);
        r.active = true;
      } finally {
        this.J.destroy(p);
        this.J.destroy(q);
        this.J.destroy(v);
        this.J.destroy(w);
      }
    }
    this.bindActiveCarriers();
  }
  deactivateBodies(ids: readonly string[]) {
    if (this.disposed) throw new Error("World disposed");
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate removal");
    for (const id of ids) {
      const r = this.registry.get(id);
      if (
        !r.active ||
        r.definition.motionType !== "dynamic" ||
        this.hasGraspForBody(id) ||
        this.grasps?.hasCarrierBindings(id)
      )
        throw new Error("Body cannot be removed");
    }
    for (const id of ids) {
      const r = this.registry.get(id);
      this.bi.RemoveBody(r.body.GetID());
      r.active = false;
    }
  }
  departLoadedCarrier(carrier: string, materials: readonly string[]) {
    const ids = [carrier, ...materials];
    if (
      this.disposed ||
      !this.grasps ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => {
        const r = this.registry.get(id);
        return (
          !r.active ||
          r.definition.motionType !== "dynamic" ||
          this.hasGraspForBody(id)
        );
      })
    )
      throw new Error("Cannot depart a held or incomplete carrier");
    this.grasps.releaseLoadForDeparture(carrier, materials);
    this.deactivateBodies(ids);
  }
  step(dt: number) {
    if (this.disposed) throw new Error("物理世界已释放");
    const substeps = this.config.carrierBindings?.length ? 8 : 2;
    for (let i = 0; i < substeps; i++) {
      this.contacts.beginSubstep();
      this.world.Step(dt / substeps, 1);
    }
  }
  readMaterial(): BodyPose {
    return this.readBody(this.targetId);
  }
  readBody(id: string): BodyPose {
    if (this.disposed) throw new Error("物理世界已释放");
    const record = this.registry.get(id);
    if (!record.active) throw new Error("Body is not present in the world");
    const body = record.body;
    const p = body.GetPosition(),
      q = body.GetRotation(),
      v = body.GetLinearVelocity();
    return {
      position: [p.GetX(), p.GetY(), p.GetZ()],
      rotation: [q.GetX(), q.GetY(), q.GetZ(), q.GetW()],
      velocity: [v.GetX(), v.GetY(), v.GetZ()],
      angularVelocity: [
        body.GetAngularVelocity().GetX(),
        body.GetAngularVelocity().GetY(),
        body.GetAngularVelocity().GetZ(),
      ],
    };
  }
  hasSupport(id = this.targetId, surface?: string) {
    return (
      this.contacts.hasSupport(id, surface) || this.isCarriedBy(id, surface)
    );
  }
  moveTool(id: string, pose: BodyPose, dt: number) {
    if (this.disposed) throw new Error("物理世界已释放");
    const r = this.registry.get(id);
    if (r.definition.motionType !== "kinematic" || r.definition.role !== "tool")
      throw new Error("不是运动学工具");
    moveTool(this.J, this.bi, r.body, pose, dt);
  }
  moveKinematicBody(id: string, pose: BodyPose, dt: number) {
    if (this.disposed) throw new Error("World disposed");
    const r = this.registry.get(id);
    if (
      r.definition.motionType !== "kinematic" ||
      !["support", "carrier"].includes(r.definition.role)
    )
      throw new Error("Not a kinematic support");
    moveTool(this.J, this.bi, r.body, pose, dt);
  }
  placeEmptyTool(id: string, pose: BodyPose) {
    const r = this.registry.get(id);
    if (
      this.disposed ||
      this.hasGraspForBody(id) ||
      r.definition.role !== "tool" ||
      r.definition.motionType !== "kinematic" ||
      ![...pose.position, ...pose.rotation].every(Number.isFinite) ||
      Math.abs(Math.hypot(...pose.rotation) - 1) > 1e-5
    )
      throw new Error("Cannot place occupied/invalid tool");
    const p = new this.J.RVec3(...pose.position),
      q = new this.J.Quat(...pose.rotation),
      zero = new this.J.Vec3(0, 0, 0);
    try {
      this.bi.SetPositionAndRotation(
        r.body.GetID(),
        p,
        q,
        this.J.EActivation_Activate,
      );
      this.bi.SetLinearAndAngularVelocity(r.body.GetID(), zero, zero);
    } finally {
      this.J.destroy(p);
      this.J.destroy(q);
      this.J.destroy(zero);
    }
  }
  bindLoad(carrier: string, material: string, fromGrasp?: string) {
    if (this.disposed || !this.grasps)
      throw new Error("Constraint backend unavailable");
    this.grasps.bindLoad(carrier, material, fromGrasp);
  }
  hasContactSupport(body: string, support: string) {
    return this.contacts.hasSupport(body, support);
  }
  isMotionStopped() {
    return (
      !this.disposed &&
      [...this.registry.values()].every((r) => {
        if (!r.active || r.definition.motionType === "static") return true;
        const p = this.readBody(r.definition.id);
        return (
          Math.hypot(...p.velocity) < 0.03 &&
          Math.hypot(...(p.angularVelocity ?? [0, 0, 0])) < 0.05
        );
      })
    );
  }
  createGrasp(id: string, tool: string, material: string) {
    if (this.disposed || !this.grasps) throw new Error("约束能力不可用");
    this.grasps.create(id, tool, material);
  }
  transferGrasp(from: string, to: string, tool: string, material: string) {
    if (this.disposed || !this.grasps) throw new Error("约束能力不可用");
    this.grasps.transferGrasp(from, to, tool, material);
  }
  removeGrasp(id: string) {
    if (this.disposed) throw new Error("物理世界已释放");
    this.grasps?.remove(id);
  }
  hasGrasp(id: string) {
    return !this.disposed && Boolean(this.grasps?.has(id));
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.grasps?.dispose();
    for (const { body: b, active } of this.registry.values()) {
      if (active) this.bi.RemoveBody(b.GetID());
      this.bi.DestroyBody(b.GetID());
    }
    this.grasps?.releaseFilter();
    this.J.destroy(this.world);
    this.contacts.dispose();
    this.registry.clear();
  }
}

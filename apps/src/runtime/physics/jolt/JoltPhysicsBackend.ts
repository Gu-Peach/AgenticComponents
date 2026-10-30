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
        if (d.motionType === "kinematic") throw new Error("运动学刚体暂不支持");
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
      this.contacts = new ConveyorContacts(J, this.registry, surfaces);
      this.system.SetContactListener(this.contacts.listener);
    } catch (e) {
      for (const { body } of this.registry.values()) {
        this.bi.RemoveBody(body.GetID());
        this.bi.DestroyBody(body.GetID());
      }
      this.registry.clear();
      J.destroy(this.world);
      throw e;
    }
  }

  private box(d: RuntimeBody) {
    const position = d.position,
      size = d.size,
      dynamic = d.motionType === "dynamic";
    const J = this.J,
      half = new J.Vec3(size[0] / 2, size[1] / 2, size[2] / 2),
      shape = new J.BoxShape(half, 0.001);
    J.destroy(half);
    const pos = new J.RVec3(...(position as [number, number, number])),
      q = new J.Quat(...d.rotation),
      settings = new J.BodyCreationSettings(
        shape,
        pos,
        q,
        dynamic ? J.EMotionType_Dynamic : J.EMotionType_Static,
        dynamic ? 1 : 0,
      );
    settings.mFriction = d.friction;
    settings.mRestitution = d.restitution;
    settings.mLinearDamping = 0;
    settings.mAllowSleeping = false;
    if (dynamic) {
      settings.mOverrideMassProperties =
        J.EOverrideMassProperties_CalculateInertia;
      settings.mMassPropertiesOverride.mMass = d.mass!;
    }
    const body = this.bi.CreateBody(settings);
    this.bi.AddBody(body.GetID(), J.EActivation_Activate);
    this.registry.add(d, body);
    J.destroy(pos);
    J.destroy(q);
    J.destroy(settings);
    return body;
  }
  setSurfaceSpeed(speed: number) {
    if (!Number.isFinite(speed)) throw new Error("表面速度必须有限");
    if (this.disposed) throw new Error("物理世界已释放");
    this.contacts.setSpeed(speed);
  }
  step(dt: number) {
    if (this.disposed) throw new Error("物理世界已释放");
    for (let i = 0; i < 2; i++) {
      this.contacts.beginSubstep();
      this.world.Step(dt / 2, 1);
    }
  }
  readMaterial(): BodyPose {
    return this.readBody(this.targetId);
  }
  readBody(id: string): BodyPose {
    if (this.disposed) throw new Error("物理世界已释放");
    const body = this.registry.get(id).body;
    const p = body.GetPosition(),
      q = body.GetRotation(),
      v = body.GetLinearVelocity();
    return {
      position: [p.GetX(), p.GetY(), p.GetZ()],
      rotation: [q.GetX(), q.GetY(), q.GetZ(), q.GetW()],
      velocity: [v.GetX(), v.GetY(), v.GetZ()],
    };
  }
  hasSupport(id = this.targetId, surface?: string) {
    return this.contacts.hasSupport(id, surface);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const { body: b } of this.registry.values()) {
      this.bi.RemoveBody(b.GetID());
      this.bi.DestroyBody(b.GetID());
    }
    this.J.destroy(this.world);
    this.contacts.dispose();
    this.registry.clear();
  }
}

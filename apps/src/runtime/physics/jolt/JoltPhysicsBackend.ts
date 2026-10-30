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
  private bodies: Jolt.Body[] = [];
  private belt: Jolt.Body;
  private material: Jolt.Body;
  private listener: Jolt.ContactListenerJS;
  private velocity: Jolt.Vec3;
  private speed = 0;
  private support = false;
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
    this.belt = this.box(config.surfacePosition, config.surfaceSize, false);
    this.box(
      [config.surfacePosition[0], -0.05, config.surfacePosition[2]],
      [20, 0.1, 20],
      false,
    );
    this.material = this.box(
      config.materialPosition,
      config.materialSize,
      true,
    );
    if (config.obstacle)
      this.box(
        [
          config.surfacePosition[0] + 0.1,
          config.surfacePosition[1] + 0.16,
          config.surfacePosition[2],
        ],
        [0.04, 0.25, 0.5],
        false,
      );
    this.velocity = new J.Vec3(0, 0, 0);
    const listener = new J.ContactListenerJS();
    listener.OnContactValidate = () =>
      J.ValidateResult_AcceptAllContactsForThisBodyPair;
    const contact = (p1: number, p2: number, mp: number, sp: number) => {
      const a = J.wrapPointer(p1, J.Body),
        b = J.wrapPointer(p2, J.Body),
        manifold = J.wrapPointer(mp, J.ContactManifold),
        key = this.belt.GetID().GetIndexAndSequenceNumber(),
        cargo = this.material.GetID().GetIndexAndSequenceNumber(),
        ka = a.GetID().GetIndexAndSequenceNumber(),
        kb = b.GetID().GetIndexAndSequenceNumber();
      const first = ka === key && kb === cargo,
        second = kb === key && ka === cargo;
      if (!(first || second)) return;
      const y = manifold.mWorldSpaceNormal.GetY() * (first ? 1 : -1);
      if (y < 0.8) return;
      this.support = true;
      const q = config.rotation;
      const vx = 1 - 2 * (q[1] * q[1] + q[2] * q[2]),
        vz = 2 * (q[0] * q[2] - q[1] * q[3]);
      this.velocity.Set(
        (first ? -1 : 1) * this.speed * vx,
        0,
        (first ? -1 : 1) * this.speed * vz,
      );
      J.wrapPointer(sp, J.ContactSettings).mRelativeLinearSurfaceVelocity =
        this.velocity;
    };
    listener.OnContactAdded = contact;
    listener.OnContactPersisted = contact;
    listener.OnContactRemoved = () => {};
    this.listener = listener;
    this.system.SetContactListener(listener);
  }
  private box(position: number[], size: number[], dynamic: boolean) {
    const J = this.J,
      half = new J.Vec3(size[0] / 2, size[1] / 2, size[2] / 2),
      shape = new J.BoxShape(half, 0.001);
    J.destroy(half);
    const pos = new J.RVec3(...(position as [number, number, number])),
      q = new J.Quat(...this.config.rotation),
      settings = new J.BodyCreationSettings(
        shape,
        pos,
        q,
        dynamic ? J.EMotionType_Dynamic : J.EMotionType_Static,
        dynamic ? 1 : 0,
      );
    settings.mFriction = this.config.friction;
    settings.mRestitution = 0;
    settings.mLinearDamping = 0;
    settings.mAllowSleeping = false;
    if (dynamic) {
      settings.mOverrideMassProperties =
        J.EOverrideMassProperties_CalculateInertia;
      settings.mMassPropertiesOverride.mMass = this.config.mass;
    }
    const body = this.bi.CreateBody(settings);
    this.bi.AddBody(body.GetID(), J.EActivation_Activate);
    this.bodies.push(body);
    J.destroy(pos);
    J.destroy(q);
    J.destroy(settings);
    return body;
  }
  setSurfaceSpeed(speed: number) {
    if (!Number.isFinite(speed)) throw new Error("表面速度必须有限");
    this.speed = speed;
  }
  step(dt: number) {
    if (this.disposed) throw new Error("物理世界已释放");
    this.support = false;
    this.world.Step(dt, 2);
  }
  readMaterial(): BodyPose {
    if (this.disposed) throw new Error("物理世界已释放");
    const p = this.material.GetPosition(),
      q = this.material.GetRotation(),
      v = this.material.GetLinearVelocity();
    return {
      position: [p.GetX(), p.GetY(), p.GetZ()],
      rotation: [q.GetX(), q.GetY(), q.GetZ(), q.GetW()],
      velocity: [v.GetX(), v.GetY(), v.GetZ()],
    };
  }
  hasSupport() {
    return this.support;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.bodies) {
      this.bi.RemoveBody(b.GetID());
      this.bi.DestroyBody(b.GetID());
    }
    this.J.destroy(this.world);
    this.J.destroy(this.listener);
    this.J.destroy(this.velocity);
    this.bodies = [];
  }
}

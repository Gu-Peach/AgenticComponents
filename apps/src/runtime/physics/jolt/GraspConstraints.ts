import type initJolt from "jolt-physics";
import type Jolt from "jolt-physics";
import { BodyRegistry } from "./BodyRegistry";
type Module = Awaited<ReturnType<typeof initJolt>>;
export class GraspConstraints {
  private constraints = new Map<
    string,
    { constraint: Jolt.Constraint; tool: string; material: string }
  >();
  private filter: Jolt.GroupFilterTable;
  private carried = new Map<
    string,
    { carrier: string; constraint: Jolt.Constraint }
  >();
  private index = new Map<string, number>();
  constructor(
    private J: Module,
    private system: Jolt.PhysicsSystem,
    private bi: Jolt.BodyInterface,
    private bodies: BodyRegistry,
  ) {
    const all = [...bodies.values()];
    this.filter = new J.GroupFilterTable(all.length);
    this.filter.AddRef();
    all.forEach(({ body, definition }, i) => {
      this.index.set(definition.id, i);
      const group = new J.CollisionGroup(this.filter, 1, i);
      bi.SetCollisionGroup(body.GetID(), group);
      J.destroy(group);
    });
  }
  create(id: string, toolId: string, materialId: string) {
    if (
      this.constraints.has(id) ||
      [...this.constraints.values()].some(
        (v) => v.material === materialId || v.tool === toolId,
      )
    )
      throw new Error("工具或物料已持有");
    const a = this.bodies.get(toolId),
      b = this.bodies.get(materialId);
    if (
      a.definition.role !== "tool" ||
      a.definition.motionType !== "kinematic" ||
      b.definition.role !== "material" ||
      b.definition.motionType !== "dynamic"
    )
      throw new Error("约束刚体角色不合法");
    const settings = new this.J.FixedConstraintSettings();
    settings.mSpace = this.J.EConstraintSpace_WorldSpace;
    settings.mAutoDetectPoint = true;
    try {
      const constraint = settings.Create(a.body, b.body);
      constraint.AddRef();
      this.system.AddConstraint(constraint);
      this.filter.DisableCollision(
        this.index.get(toolId)!,
        this.index.get(materialId)!,
      );
      this.bi.ActivateBody(b.body.GetID());
      this.constraints.set(id, {
        constraint,
        tool: toolId,
        material: materialId,
      });
      this.releaseCarrier(materialId);
    } finally {
      this.J.destroy(settings);
    }
  }
  carry(carrier: string, material: string) {
    if (this.carried.has(material) || this.involves(material))
      throw new Error("Material already constrained");
    const a = this.bodies.get(carrier),
      b = this.bodies.get(material);
    if (
      !a.active ||
      !b.active ||
      a.definition.role !== "carrier" ||
      b.definition.role !== "material"
    )
      throw new Error("Invalid carrier constraint");
    const settings = new this.J.FixedConstraintSettings();
    settings.mSpace = this.J.EConstraintSpace_WorldSpace;
    settings.mAutoDetectPoint = true;
    try {
      const constraint = settings.Create(a.body, b.body);
      constraint.AddRef();
      this.system.AddConstraint(constraint);
      this.filter.DisableCollision(
        this.index.get(carrier)!,
        this.index.get(material)!,
      );
      this.carried.set(material, { carrier, constraint });
    } finally {
      this.J.destroy(settings);
    }
  }
  isCarriedBy(material: string, carrier?: string) {
    const c = this.carried.get(material);
    return !!c && (!carrier || c.carrier === carrier);
  }
  hasCarrierBindings(id: string) {
    return (
      this.carried.has(id) ||
      [...this.carried.values()].some((c) => c.carrier === id)
    );
  }
  private releaseCarrier(material: string) {
    const c = this.carried.get(material);
    if (!c) return;
    this.system.RemoveConstraint(c.constraint);
    c.constraint.Release();
    this.filter.EnableCollision(
      this.index.get(c.carrier)!,
      this.index.get(material)!,
    );
    this.carried.delete(material);
  }
  has(id: string) {
    return this.constraints.has(id);
  }
  involves(bodyId: string) {
    return [...this.constraints.values()].some(
      (c) => c.tool === bodyId || c.material === bodyId,
    );
  }
  remove(id: string) {
    const v = this.constraints.get(id);
    if (!v) return;
    this.system.RemoveConstraint(v.constraint);
    v.constraint.Release();
    this.filter.EnableCollision(
      this.index.get(v.tool)!,
      this.index.get(v.material)!,
    );
    this.constraints.delete(id);
  }
  dispose() {
    for (const id of [...this.constraints.keys()]) this.remove(id);
    for (const material of [...this.carried.keys()])
      this.releaseCarrier(material);
  }
  releaseFilter() {
    this.filter.Release();
  }
}

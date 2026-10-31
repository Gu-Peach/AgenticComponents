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
    } finally {
      this.J.destroy(settings);
    }
  }
  has(id: string) {
    return this.constraints.has(id);
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
  }
  releaseFilter() {
    this.filter.Release();
  }
}

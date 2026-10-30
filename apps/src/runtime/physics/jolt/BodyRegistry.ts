import type Jolt from "jolt-physics";
import type { RuntimeBody } from "@/contracts/physics";
export class BodyRegistry {
  private byId = new Map<
    string,
    { body: Jolt.Body; definition: RuntimeBody }
  >();
  private byKey = new Map<number, string>();
  add(definition: RuntimeBody, body: Jolt.Body) {
    if (this.byId.has(definition.id)) throw new Error("重复刚体 ID");
    this.byId.set(definition.id, { body, definition });
    this.byKey.set(body.GetID().GetIndexAndSequenceNumber(), definition.id);
  }
  get(id: string) {
    const item = this.byId.get(id);
    if (!item) throw new Error(`刚体不存在: ${id}`);
    return item;
  }
  fromKey(key: number) {
    const id = this.byKey.get(key);
    return id ? this.byId.get(id) : undefined;
  }
  values() {
    return this.byId.values();
  }
  clear() {
    this.byKey.clear();
    this.byId.clear();
  }
}

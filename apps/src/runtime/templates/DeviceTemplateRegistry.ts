import type { DeviceTemplate } from "@/contracts/device-template";
export class DeviceTemplateRegistry {
  private templates = new Map<string, DeviceTemplate>();
  register(t: DeviceTemplate) {
    if (this.templates.has(t.id)) throw new Error("模板重复注册");
    this.templates.set(t.id, t);
  }
  get(id: string) {
    const t = this.templates.get(id);
    if (!t) throw new Error(`模板未支持: ${id}`);
    return t;
  }
}

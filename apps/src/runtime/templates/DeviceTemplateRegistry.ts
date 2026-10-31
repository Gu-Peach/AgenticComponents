import type { RobotArmTemplate } from "./robot/RobotArmTemplate";
import type { DeviceTemplate } from "@/contracts/device-template";
export class DeviceTemplateRegistry {
  private robot?: typeof RobotArmTemplate;
  registerRobot(t: typeof RobotArmTemplate) {
    if (this.robot) throw new Error("模板重复注册");
    this.robot = t;
  }
  getRobot() {
    if (!this.robot) throw new Error("机械臂模板未注册");
    return this.robot;
  }
  private templates = new Map<string, DeviceTemplate>();
  register(t: DeviceTemplate) {
    if (this.templates.has(t.id)) throw new Error("模板重复注册");
    this.templates.set(t.id, t);
  }
  get(id: "robot.articulated"): typeof RobotArmTemplate;
  get(id: string): DeviceTemplate;
  get(id: string) {
    if (id === "robot.articulated") return this.getRobot();
    const t = this.templates.get(id);
    if (!t) throw new Error(`模板未支持: ${id}`);
    return t;
  }
}

/** 创建单设备仿真的模板注册表，登记连续接触输送带和关节机械臂的实现。 */

import { getDeviceModule } from "@/devices/registry";
import { DeviceTemplateRegistry } from "./DeviceTemplateRegistry";
export function registerTemplates() {
  const registry = new DeviceTemplateRegistry();
  registry.register(getDeviceModule("conveyor").standaloneTemplate);
  registry.registerRobot(getDeviceModule("robot_arm").standaloneTemplate);
  return registry;
}

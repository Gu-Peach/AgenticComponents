/** 创建单设备仿真的模板注册表，登记连续接触输送带和关节机械臂的实现。 */

import { RobotArmTemplate } from "./robot/RobotArmTemplate";
import { DeviceTemplateRegistry } from "./DeviceTemplateRegistry";
import { ConveyorTemplate } from "./conveyor/ConveyorTemplate";
export function registerTemplates() {
  const registry = new DeviceTemplateRegistry();
  registry.register(ConveyorTemplate);
  registry.registerRobot(RobotArmTemplate);
  return registry;
}

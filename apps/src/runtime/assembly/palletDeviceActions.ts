/** 原托盘线函数的兼容导出，函数由设备库维护。 */
export {
  bodyOf,
  carrierPlacement,
  originOffset,
} from "@/devices/workpiece/behavior";

export { homeAction, topPickAndPlace } from "@/devices/robot_arm/behavior";
export { createConveyorGroup } from "@/devices/conveyor/behavior";

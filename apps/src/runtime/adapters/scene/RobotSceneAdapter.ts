/** 将场景中的抓放和位姿请求交给机械臂任务执行器，在共享物理世界中推进动作，向调度器反馈关节状态、放置结果及故障。 */

export { RobotSceneAdapter } from "@/devices/robot_arm/behavior";
export type { PreparedRobotAction } from "@/devices/robot_arm/behavior";

/** 创建机械臂命令程序、场景抓放、双臂交接和加工运动实例。 */
import contract from "./contract.json";
import { compileRobotExperiment } from "@/domain/runtime/compileRobotExperiment";
import {
  bindPickPlaceConditions,
  RobotArmTemplate,
  RobotProgram,
  RobotSceneAdapter,
  HandoffArm,
  RobotProcessingMotion,
  PickPlaceMotion,
  homeAction,
  topPickAndPlace,
  pickAndPlaceOnBelt,
  pickPlaceSteps,
  createJobDriver,
  createProcessingDriver,
} from "./behavior";
const robotArmModule = {
  type: "robot_arm" as const,
  contract,
  bindPickPlaceConditions,
  standaloneTemplate: RobotArmTemplate,
  compileStandalone: compileRobotExperiment,
  createProgram: (...args: ConstructorParameters<typeof RobotProgram>) =>
    new RobotProgram(...args),
  createSceneDriver: (
    ...args: ConstructorParameters<typeof RobotSceneAdapter>
  ) => new RobotSceneAdapter(...args),
  createArticulatedArm: (...args: ConstructorParameters<typeof HandoffArm>) =>
    new HandoffArm(...args),
  createProcessingMotion: (
    ...args: ConstructorParameters<typeof RobotProcessingMotion>
  ) => new RobotProcessingMotion(...args),
  createPickPlaceMotion: (
    ...args: ConstructorParameters<typeof PickPlaceMotion>
  ) => new PickPlaceMotion(...args),
  createJobDriver,
  createProcessingDriver,
  homeAction,
  topPickAndPlace,
  pickAndPlaceOnBelt,
  pickPlaceSteps,
};

export default robotArmModule;

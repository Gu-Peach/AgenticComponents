/** 注册升降台的契约和实例工厂。 */
import contract from "./contract.json";
import {
  LiftSceneAdapter,
  createLiftAxisDriver,
  transferFields,
} from "./behavior";

const liftTableModule = {
  type: "lift_table" as const,
  contract,
  createDriver: (...args: ConstructorParameters<typeof LiftSceneAdapter>) =>
    new LiftSceneAdapter(...args),
  createAxisDriver: createLiftAxisDriver,
  transferFields,
};

export default liftTableModule;

/** 注册升降台的契约和实例工厂。 */
import contract from "./contract.json";
import { LiftSceneAdapter, transferFields } from "./behavior";

const liftTableModule = {
  type: "lift_table" as const,
  contract,
  createDriver: (...args: ConstructorParameters<typeof LiftSceneAdapter>) =>
    new LiftSceneAdapter(...args),
  transferFields,
};

export default liftTableModule;

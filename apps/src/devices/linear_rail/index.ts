/** 注册直线滑轨的契约和实例工厂。 */
import contract from "./contract.json";
import { LinearRailSceneAdapter } from "./behavior";

const linearRailModule = {
  type: "linear_rail" as const,
  contract,
  createDriver: (
    ...args: ConstructorParameters<typeof LinearRailSceneAdapter>
  ) => new LinearRailSceneAdapter(...args),
};

export default linearRailModule;

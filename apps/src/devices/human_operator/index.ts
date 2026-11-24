/** 注册搬运人员的契约和实例工厂。 */
import contract from "./contract.json";
import { HumanCarryMotion, createCarryDriver } from "./behavior";

const humanOperatorModule = {
  type: "human_operator" as const,
  contract,
  createMotion: (...args: ConstructorParameters<typeof HumanCarryMotion>) =>
    new HumanCarryMotion(...args),
  createDriver: createCarryDriver,
};

export default humanOperatorModule;

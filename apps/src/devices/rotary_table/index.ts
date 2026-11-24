/** 注册旋转台的契约和实例工厂。 */
import contract from "./contract.json";
import { RotaryIndexMotion, TableIndexAdapter } from "./behavior";

const rotaryTableModule = {
  type: "rotary_table" as const,
  contract,
  createMotion: (...args: ConstructorParameters<typeof RotaryIndexMotion>) =>
    new RotaryIndexMotion(...args),
  createDriver: (...args: ConstructorParameters<typeof TableIndexAdapter>) =>
    new TableIndexAdapter(...args),
};

export default rotaryTableModule;

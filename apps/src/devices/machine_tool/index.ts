/** 注册机床的契约和实例工厂。 */
import contract from "./contract.json";
import {
  MachineToolAdapter,
  MachineWorkpoint,
  evaluateMachiningCondition,
  machiningConditions,
} from "./behavior";

const machineToolModule = {
  type: "machine_tool" as const,
  contract,
  conditions: machiningConditions,
  evaluateCondition: evaluateMachiningCondition,
  createWorkpoint: (observedReady: (material: string) => boolean) =>
    new MachineWorkpoint(observedReady),
  createDriver: (...args: ConstructorParameters<typeof MachineToolAdapter>) =>
    new MachineToolAdapter(...args),
};

export default machineToolModule;

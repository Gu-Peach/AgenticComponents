/** 注册仓储柜的契约和实例工厂。 */
import contract from "./contract.json";
import { StorageRackRuntime } from "./behavior";

const storageRackModule = {
  type: "storage_rack" as const,
  contract,
  createInventory: (slots: ReadonlySet<string>) =>
    new StorageRackRuntime(slots),
};

export default storageRackModule;

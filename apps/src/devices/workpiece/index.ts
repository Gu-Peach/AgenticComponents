/** 登记物料的被动刚体与可选承载服务，托盘沿用物料类型。 */
import contract from "./contract.json";
import {
  bodyOf,
  carrierPlacement,
  originOffset,
  CarrierInventory,
  isCarryingWorkpiece,
  normalizeSceneCarrying,
  passiveMaterialDescriptor,
} from "./behavior";
const workpieceModule = {
  type: "workpiece" as const,
  contract,
  bodyOf,
  carrierPlacement,
  originOffset,
  isCarryingWorkpiece,
  normalizeSceneCarrying,
  passiveMaterialDescriptor,
  createInventory: (slots: readonly string[]) => new CarrierInventory(slots),
};

export default workpieceModule;

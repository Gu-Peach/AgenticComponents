/** 注册出料站的契约与每次运行独有的物料准入记录。 */
import type { PhysicsPort } from "@/contracts/physics";
import contract from "./contract.json";
import { MaterialSupply } from "./behavior";
const materialSourceStationModule = {
  type: "material_source_station" as const,
  contract,
  createSupply: (physics: PhysicsPort) => new MaterialSupply(physics),
};

export default materialSourceStationModule;

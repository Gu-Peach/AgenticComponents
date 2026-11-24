/** 创建输送带的单机、整场景和联动组实现，按会话独立管理状态。 */
import contract from "./contract.json";
import type { ProjectDocument } from "@/contracts/device";
import { compileConveyor } from "@/domain/runtime/compileConveyor";
import { compileDeclarativeScene } from "@/domain/runtime/compileDeclarativeScene";
import {
  bindExitConditions,
  ConveyorTemplate,
  ConveyorProgram,
  PositionTransportAdapter,
  createConveyorGroup,
} from "./behavior";
const conveyorModule = {
  type: "conveyor" as const,
  contract,
  bindExitConditions,
  standaloneTemplate: ConveyorTemplate,
  compileStandalone(project: ProjectDocument, id: string, materialId?: string) {
    const instance = project.instances.find((i) => i.instanceId === id);
    const definition = project.definitions.find(
      (d) =>
        d.specId === instance?.specId && d.revision === instance?.specRevision,
    );
    if (!instance?.visible || definition?.deviceType !== "conveyor")
      throw new Error("请选择可见的真实传送带");
    if (definition.source?.contract_version === "1.3") {
      if (!materialId) throw new Error("请选择场景中的物料");
      return compileDeclarativeScene(project, id, materialId);
    }
    return compileConveyor(definition, instance, project.revision);
  },
  createProgram: (...args: ConstructorParameters<typeof ConveyorProgram>) =>
    new ConveyorProgram(...args),
  createSceneDriver: (
    ...args: ConstructorParameters<typeof PositionTransportAdapter>
  ) => new PositionTransportAdapter(...args),
  createGroup: createConveyorGroup,
};

export default conveyorModule;

import type { RobotExperimentOptions } from "./compileRobotExperiment";
import type { ProjectDocument } from "@/contracts/device";
import { getDeviceModule } from "@/devices/registry";

export function compileRuntimeScene(
  project: ProjectDocument,
  id: string,
  materialId?: string,
  robotOptions?: RobotExperimentOptions,
) {
  const i = project.instances.find((i) => i.instanceId === id);
  const d = project.definitions.find(
    (d) => d.specId === i?.specId && d.revision === i.specRevision,
  );
  if (!i?.visible || !d) throw new Error("请选择版本匹配且可见的设备实例");
  const deviceModule = getDeviceModule(d.deviceType);
  switch (deviceModule.type) {
    case "robot_arm":
      return deviceModule.compileStandalone(project, id, robotOptions);
    case "conveyor":
      return deviceModule.compileStandalone(project, id, materialId);
    default:
      throw new Error("该设备没有独立运行入口：" + deviceModule.type);
  }
}

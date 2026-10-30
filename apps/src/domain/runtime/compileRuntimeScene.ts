import { compileDeclarativeScene } from "./compileDeclarativeScene";
import type { ProjectDocument } from "@/contracts/device";
import { compileConveyor } from "./compileConveyor";
export function compileRuntimeScene(
  project: ProjectDocument,
  id: string,
  materialId?: string,
) {
  const i = project.instances.find((i) => i.instanceId === id),
    d = project.definitions.find((d) => d.specId === i?.specId);
  if (!i || !d || !i.visible) throw new Error("请选择可见的真实传送带");
  if (d.source?.contract_version === "1.3") {
    if (!materialId) throw new Error("请选择场景中的物料");
    return compileDeclarativeScene(project, id, materialId);
  }
  return compileConveyor(d, i, project.revision);
}

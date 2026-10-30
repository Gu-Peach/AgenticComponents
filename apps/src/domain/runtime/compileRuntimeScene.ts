import type { ProjectDocument } from "@/contracts/device";
import { compileConveyor } from "./compileConveyor";
export function compileRuntimeScene(project: ProjectDocument, id: string) {
  const i = project.instances.find((i) => i.instanceId === id),
    d = project.definitions.find((d) => d.specId === i?.specId);
  if (!i || !d || !i.visible) throw new Error("请选择可见的真实传送带");
  return compileConveyor(d, i, project.revision);
}

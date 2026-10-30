import type { ProjectDocument, Transform } from "@/contracts/device";
import { useWorkspace } from "@/stores/workspace";
import type { SnapCandidate } from "@/domain/spatial/snap";
export function commitTransform(
  project: ProjectDocument,
  id: string,
  transform: Transform,
  candidate: SnapCandidate | null,
) {
  const state = useWorkspace.getState();
  if (state.project !== project || state.documentLocked) return false;
  if (
    ![...transform.position, ...transform.rotation, ...transform.scale].every(
      Number.isFinite,
    ) ||
    !transform.scale.every((n) => n > 0)
  )
    return false;
  const instance = project.instances.find((i) => i.instanceId === id);
  if (!instance) return false;
  if (
    !candidate &&
    JSON.stringify(instance.transform) === JSON.stringify(transform)
  )
    return true;
  state.updateProject((p) => ({
    ...p,
    instances: p.instances.map((i) =>
      i.instanceId === id ? { ...i, transform } : i,
    ),
    connections: [
      ...(p.connections ?? []).filter(
        (c) => c.a.instanceId !== id && c.b.instanceId !== id,
      ),
      ...(candidate
        ? [
            {
              id: crypto.randomUUID(),
              a: { instanceId: id, interfaceId: candidate.sourceInterface },
              b: {
                instanceId: candidate.targetInstance,
                interfaceId: candidate.targetInterface,
              },
            },
          ]
        : []),
    ],
  }));
  state.log(
    candidate
      ? `接口吸附：${candidate.sourceInterface} → ${candidate.targetInterface}`
      : "设备位姿已更新",
  );
  return true;
}

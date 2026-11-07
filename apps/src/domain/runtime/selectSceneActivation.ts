import type { SchedulerSnapshot } from "@/contracts/scheduler";
/** Rejects a previous iteration even before the next iteration has created this node. */
export function selectSceneActivation(
  process: Readonly<SchedulerSnapshot> | undefined,
  nodeId: string,
) {
  if (!process) return undefined;
  const byId = new Map(process.activations.map((a) => [a.id, a]));
  const current = (start: SchedulerSnapshot["activations"][number]) => {
    let child = start;
    const seen = new Set<string>();
    while (child.parentId) {
      if (seen.has(child.id)) return false;
      seen.add(child.id);
      const parent = byId.get(child.parentId);
      if (!parent) return false;
      if (
        parent.totalIterations !== undefined &&
        parent.iteration !== undefined
      ) {
        const selected = process.activations.filter(
          (a) => a.parentId === parent.id,
        )[parent.iteration - 1];
        if (selected?.id !== child.id) return false;
      }
      child = parent;
    }
    return true;
  };
  return process.activations.filter((a) => a.node === nodeId).findLast(current);
}

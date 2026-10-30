import { useInteraction } from "@/stores/interaction";
import { useWorkspace } from "@/stores/workspace";
import { findSnap } from "@/domain/spatial/snap";
import { commitTransform } from "@/editor/transformActions";
export function TransformToolbar() {
  const { mode, snapEnabled, drag, candidate } = useInteraction();
  const { project, selectedId, documentLocked } = useWorkspace();
  const selected = project?.instances.find((i) => i.instanceId === selectedId);
  const nearest = project && selected ? findSnap(project, selected) : null;
  return (
    <>
      <button
        className={mode === "translate" ? "tool-active" : ""}
        aria-label="移动模型"
        aria-pressed={mode === "translate"}
        disabled={documentLocked || Boolean(drag)}
        onClick={() => useInteraction.setState({ mode: "translate" })}
      >
        移动
      </button>
      <button
        className={mode === "rotate" ? "tool-active" : ""}
        aria-label="旋转模型"
        aria-pressed={mode === "rotate"}
        disabled={documentLocked || Boolean(drag)}
        onClick={() => useInteraction.setState({ mode: "rotate" })}
      >
        旋转
      </button>
      <button
        aria-label="接口吸附"
        aria-pressed={snapEnabled}
        className={snapEnabled ? "tool-active" : ""}
        disabled={Boolean(drag)}
        onClick={() => useInteraction.setState({ snapEnabled: !snapEnabled })}
      >
        吸附
      </button>
      <button
        aria-label="吸附到邻近接口"
        disabled={!nearest || documentLocked || Boolean(drag) || !snapEnabled}
        onClick={() => {
          if (project && selected && nearest)
            commitTransform(
              project,
              selected.instanceId,
              nearest.transform,
              nearest,
            );
        }}
      >
        对齐
      </button>
      {candidate && (
        <span role="status" className="snap-hint">
          松开吸附 · {candidate.targetInterface}
        </span>
      )}
    </>
  );
}

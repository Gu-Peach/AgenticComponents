import { useCallback, useEffect, useRef, type RefObject } from "react";
import { TransformControls } from "@react-three/drei";
import type { TransformControls as Controls } from "three-stdlib";
import type { Group } from "three";
import type {
  DeviceInstance,
  ProjectDocument,
  Transform,
} from "@/contracts/device";
import { useWorkspace } from "@/stores/workspace";
import { useInteraction } from "@/stores/interaction";
import { findSnap } from "@/domain/spatial/snap";
import { commitTransform } from "@/editor/transformActions";
function restoreRoot(root: RefObject<Group>, t: Transform) {
  if (root.current) {
    root.current.position.fromArray(t.position);
    root.current.rotation.set(...t.rotation);
    root.current.scale.fromArray(t.scale);
  }
}
export function DeviceTransformControls({
  instance,
  root,
}: {
  instance: DeviceInstance;
  root: RefObject<Group>;
}) {
  const mode = useInteraction((s) => s.mode);
  const controls = useRef<Controls>(null);
  const start = useRef<{
    project: ProjectDocument;
    transform: Transform;
  } | null>(null);
  const cancel = useCallback(() => {
    const current = start.current;
    if (!current) return;
    start.current = null;
    restoreRoot(root, current.transform);
    if (current) {
      controls.current?.reset();
      document.dispatchEvent(new PointerEvent("pointerup", { button: 0 }));
    }
    useInteraction.setState({
      drag: null,
      candidate: null,
      suppressClickUntil: Date.now() + 150,
    });
  }, [root]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && start.current) {
        e.preventDefault();
        cancel();
      }
    };
    const blur = () => cancel();
    window.addEventListener("keydown", key);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", blur);
      cancel();
    };
  }, [cancel]);
  const pose = (): Transform => ({
    position: root.current.position.toArray(),
    rotation: [
      root.current.rotation.x,
      root.current.rotation.y,
      root.current.rotation.z,
    ],
    scale: root.current.scale.toArray(),
  });
  return (
    <TransformControls
      object={root}
      ref={controls}
      mode={mode}
      space="world"
      size={0.8}
      onMouseDown={() => {
        const state = useWorkspace.getState();
        if (!state.project || state.documentLocked) return;
        start.current = {
          project: state.project,
          transform: structuredClone(instance.transform),
        };
        useInteraction.setState({
          drag: { instanceId: instance.instanceId, transform: pose() },
          candidate: null,
        });
      }}
      onObjectChange={() => {
        const active = start.current;
        if (!active) return;
        if (
          useWorkspace.getState().project !== active.project ||
          useWorkspace.getState().documentLocked
        ) {
          cancel();
          return;
        }
        const transform = pose();
        const candidate = useInteraction.getState().snapEnabled
          ? findSnap(active.project, { ...instance, transform })
          : null;
        useInteraction.setState({
          drag: { instanceId: instance.instanceId, transform },
          candidate,
        });
      }}
      onMouseUp={() => {
        const active = start.current;
        if (!active) return;
        const candidate = useInteraction.getState().candidate;
        const transform = candidate?.transform ?? pose();
        if (
          !commitTransform(
            active.project,
            instance.instanceId,
            transform,
            candidate,
          )
        ) {
          cancel();
          return;
        }
        start.current = null;
        useInteraction.setState({
          drag: null,
          candidate: null,
          suppressClickUntil: Date.now() + 150,
        });
      }}
    />
  );
}

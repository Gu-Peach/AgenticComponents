import { useEffect, useState } from "react";
import type { Object3D } from "three";
import { Html } from "@react-three/drei";
import { acquireModel } from "@/services/ModelRepository";
import { useWorkspace } from "@/stores/workspace";
import { RobotSceneBridge } from "./RobotSceneBridge";
import { SelectionHighlight } from "./SelectionHighlight";
import { ScenePhysicsBridge } from "./ScenePhysicsBridge";
export function ImportedModel({
  assetId,
  instanceId,
  selected,
}: {
  assetId: string;
  instanceId: string;
  selected: boolean;
}) {
  const [failure, setFailure] = useState("");
  const [retry, setRetry] = useState(0);
  const [model, setModel] = useState<Object3D | null>(null);
  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    const state = useWorkspace.getState();
    useWorkspace.setState({
      modelErrors: { ...state.modelErrors, [instanceId]: "" },
    });
    (async () => {
      const loaded = await acquireModel(assetId);
      release = loaded.release;
      const owned = loaded.root;
      if (disposed) {
        release();
        return;
      }
      const nodes: string[] = [];
      owned.traverse((o) => {
        if (o.name) nodes.push(o.name);
      });
      useWorkspace.setState((s) => ({
        modelNodes: { ...s.modelNodes, [instanceId]: nodes },
      }));
      setModel(owned);
    })().catch((e) => {
      if (!disposed) {
        setFailure(String(e.message));
        useWorkspace.setState((s) => ({
          modelErrors: { ...s.modelErrors, [instanceId]: String(e.message) },
        }));
        useWorkspace.getState().log(`${instanceId}: ${e.message}`, "error");
      }
    });
    return () => {
      disposed = true;
      release?.();
    };
  }, [assetId, instanceId, retry]);
  useEffect(() => {
    if (model && useWorkspace.getState().selectedId === instanceId)
      useWorkspace.setState((s) => ({ focusToken: s.focusToken + 1 }));
  }, [model, instanceId]);
  if (failure)
    return (
      <Html center>
        <button
          onClick={() => {
            setFailure("");
            setRetry((r) => r + 1);
          }}
          title={failure}
        >
          模型加载失败 · 重试
        </button>
      </Html>
    );
  return model ? (
    <>
      <primitive object={model} dispose={null} />
      <RobotSceneBridge model={model} instanceId={instanceId} />
      <ScenePhysicsBridge model={model} instanceId={instanceId} />
      <SelectionHighlight model={model} selected={selected} />
    </>
  ) : (
    <Html center>
      <span className="model-loading">正在加载模型…</span>
    </Html>
  );
}

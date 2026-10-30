"use client";
import { DeviceTransformControls } from "./DeviceTransformControls";
import { useInteraction } from "@/stores/interaction";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport } from "@react-three/drei";
import { Box3, Group, Object3D, Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { acquireModel } from "@/services/ModelRepository";
import { SelectionHighlight } from "./SelectionHighlight";
import { InterfaceMarkers } from "./InterfaceMarkers";
import { Html } from "@react-three/drei";
import { useWorkspace } from "@/stores/workspace";
import type { DeviceDefinition, DeviceInstance } from "@/contracts/device";
import { DeviceShape } from "./DeviceShape";
import { sceneObjects } from "./SceneObjectRegistry";

function ImportedModel({
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
      <SelectionHighlight model={model} selected={selected} />
    </>
  ) : (
    <Html center>
      <span className="model-loading">正在加载模型…</span>
    </Html>
  );
}
function Device({
  instance,
  definition,
  selected,
}: {
  instance: DeviceInstance;
  definition: DeviceDefinition;
  selected: boolean;
}) {
  const root = useRef<Group>(null!);
  const live = useInteraction((s) =>
    s.drag?.instanceId === instance.instanceId
      ? s.drag.transform
      : instance.transform,
  );
  const locked = useWorkspace((s) => s.documentLocked);
  const body = useRef<Group>(null!);
  useEffect(
    () =>
      root.current
        ? sceneObjects.register(instance.instanceId, root.current)
        : undefined,
    [instance.instanceId],
  );
  return (
    <>
      <group
        ref={root}
        visible={instance.visible}
        position={live.position}
        rotation={live.rotation}
        scale={live.scale}
        onClick={(e) => {
          e.stopPropagation();
          if (
            !useInteraction.getState().drag &&
            Date.now() > useInteraction.getState().suppressClickUntil
          )
            useWorkspace.getState().select(instance.instanceId);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          useWorkspace.setState((s) => ({
            selectedId: instance.instanceId,
            focusToken: s.focusToken + 1,
          }));
        }}
      >
        <group
          position={definition.asset.importTransform?.position}
          rotation={definition.asset.importTransform?.rotation}
          scale={definition.asset.importTransform?.scale}
        >
          <group ref={body}>
            {definition.asset.assetId ? (
              <ImportedModel
                key={definition.asset.assetId}
                assetId={definition.asset.assetId}
                instanceId={instance.instanceId}
                selected={selected}
              />
            ) : (
              <DeviceShape type={definition.deviceType} />
            )}
          </group>
          {selected && (
            <InterfaceMarkers
              definition={definition}
              instance={instance}
              occluder={body}
            />
          )}
        </group>
      </group>
      {selected && !locked && (
        <DeviceTransformControls instance={instance} root={root} />
      )}
    </>
  );
}
function CameraRig({ token }: { token: number }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const lastToken = useRef(token);
  useEffect(() => {
    if (token === lastToken.current) return;
    lastToken.current = token;
    const id = useWorkspace.getState().selectedId;
    const root = id ? sceneObjects.node(id, "$root") : null;
    if (!controls.current) return;
    const center = root
      ? new Box3().setFromObject(root).getCenter(new Vector3())
      : new Vector3(0, 0.4, 0);
    const size = root
      ? new Box3().setFromObject(root).getSize(new Vector3()).length()
      : 8;
    camera.position.copy(
      center
        .clone()
        .add(new Vector3(1, 0.8, 1.2).multiplyScalar(Math.max(size, 2))),
    );
    controls.current.target.copy(center);
    controls.current.update();
  }, [token, camera]);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      minDistance={1}
      maxDistance={45}
      maxPolarAngle={Math.PI * 0.49}
      target={[0, 0.4, 0]}
    />
  );
}
class CanvasBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="empty-state">
        三维视口不可用，请检查浏览器 WebGL 支持。设备与项目面板仍可使用。
      </div>
    ) : (
      this.props.children
    );
  }
}
export default function SceneCanvas() {
  const project = useWorkspace((s) => s.project);
  const selectedId = useWorkspace((s) => s.selectedId);
  const focusToken = useWorkspace((s) => s.focusToken);
  const [ready, setReady] = useState(false);
  const selected = project?.instances.find((i) => i.instanceId === selectedId);
  return (
    <CanvasBoundary>
      <Canvas
        data-scene-ready={ready ? "true" : "false"}
        shadows
        dpr={[1, 1.5]}
        camera={{ position: [9, 7.5, 10], fov: 43 }}
        gl={{ antialias: true }}
        onPointerMissed={() => {
          if (
            !useInteraction.getState().drag &&
            Date.now() > useInteraction.getState().suppressClickUntil
          )
            useWorkspace.getState().select(null);
        }}
      >
        <color attach="background" args={["#171e26"]} />
        <fog attach="fog" args={["#171e26", 20, 55]} />
        <ambientLight intensity={1.1} />
        <hemisphereLight args={["#b2d9ee", "#394452", 1.4]} />
        <directionalLight
          position={[5, 10, 5]}
          intensity={3}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-12}
          shadow-camera-right={12}
          shadow-camera-top={12}
          shadow-camera-bottom={-12}
          shadow-bias={-0.0005}
        />
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -0.025, 0]}
          receiveShadow
        >
          <planeGeometry args={[200, 200]} />
          <meshStandardMaterial color="#202b35" roughness={0.9} />
        </mesh>
        <gridHelper
          position={[0, -0.01, 0]}
          args={[100, 200, "#455968", "#34424f"]}
        />
        {project?.instances.map((i) => {
          const d = project.definitions.find((d) => d.specId === i.specId);
          return d ? (
            <Device
              key={i.instanceId}
              instance={i}
              definition={d}
              selected={selectedId === i.instanceId}
            />
          ) : null;
        })}
        <CameraRig token={focusToken} />
        <FrameReady onReady={() => setReady(true)} />
        <GizmoHelper alignment="top-right" margin={[55, 60]}>
          <GizmoViewport
            axisColors={["#e67f79", "#8fca94", "#75aee1"]}
            labelColor="#e7edf4"
            hideNegativeAxes
          />
        </GizmoHelper>
      </Canvas>
      {ready && selected && (
        <div className="viewport-selection">
          <div className="scene-label">
            {selected.name}
            <span>SELECTED</span>
          </div>
        </div>
      )}
    </CanvasBoundary>
  );
}

function FrameReady({ onReady }: { onReady: () => void }) {
  const frames = useRef(0);
  useFrame(() => {
    if (++frames.current === 2) onReady();
  });
  return null;
}

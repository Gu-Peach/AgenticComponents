"use client";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport } from "@react-three/drei";
import { Box3, Group, Mesh, Object3D, Texture, Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { useWorkspace } from "@/stores/workspace";
import type { DeviceDefinition, DeviceInstance } from "@/contracts/device";
import { DeviceShape } from "./DeviceShape";
import { sceneObjects } from "./SceneObjectRegistry";
import { projectRepository } from "@/services/BrowserProjectRepository";
function disposeModel(root: Object3D) {
  const textures = new Set<Texture>();
  root.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        Object.values(m).forEach((v) => {
          if (v instanceof Texture) textures.add(v);
        });
        m.dispose();
      }
    }
  });
  textures.forEach((t) => t.dispose());
}
function ImportedModel({
  assetId,
  instanceId,
  fallback,
}: {
  assetId: string;
  instanceId: string;
  fallback: ReactNode;
}) {
  const [model, setModel] = useState<Object3D | null>(null);
  useEffect(() => {
    let disposed = false;
    let owned: Object3D | undefined;
    const state = useWorkspace.getState();
    useWorkspace.setState({
      modelErrors: { ...state.modelErrors, [instanceId]: "" },
    });
    (async () => {
      const blob = await projectRepository.getAsset(assetId);
      if (!blob) throw new Error("模型文件缺失，请重新关联 GLB");
      const data = await blob.arrayBuffer();
      if (disposed) return;
      const gltf = await new GLTFLoader().parseAsync(data, "");
      owned = gltf.scene;
      if (disposed) {
        disposeModel(owned);
        return;
      }
      const nodes: string[] = [];
      owned.traverse((o) => {
        if (o.name) nodes.push(o.name);
        if (o instanceof Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      useWorkspace.setState((s) => ({
        modelNodes: { ...s.modelNodes, [instanceId]: nodes },
      }));
      setModel(owned);
    })().catch((e) => {
      if (!disposed) {
        useWorkspace.setState((s) => ({
          modelErrors: { ...s.modelErrors, [instanceId]: String(e.message) },
        }));
        useWorkspace.getState().log(`${instanceId}: ${e.message}`, "error");
      }
    });
    return () => {
      disposed = true;
      if (owned) disposeModel(owned);
    };
  }, [assetId, instanceId]);
  return model ? <primitive object={model} dispose={null} /> : fallback;
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
  const root = useRef<Group>(null);
  useEffect(
    () =>
      root.current
        ? sceneObjects.register(instance.instanceId, root.current)
        : undefined,
    [instance.instanceId],
  );
  return (
    <group
      ref={root}
      visible={instance.visible}
      position={instance.transform.position}
      rotation={instance.transform.rotation}
      scale={instance.transform.scale}
      onClick={(e) => {
        e.stopPropagation();
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
      {definition.asset.assetId ? (
        <ImportedModel
          key={definition.asset.assetId}
          assetId={definition.asset.assetId}
          instanceId={instance.instanceId}
          fallback={<DeviceShape type={definition.deviceType} />}
        />
      ) : (
        <DeviceShape type={definition.deviceType} />
      )}
      {selected && (
        <group>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
            <ringGeometry args={[1.02, 1.045, 64]} />
            <meshBasicMaterial color="#64c9e7" transparent opacity={0.85} />
          </mesh>
        </group>
      )}
    </group>
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
        onPointerMissed={() => useWorkspace.getState().select(null)}
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

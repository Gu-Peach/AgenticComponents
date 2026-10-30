import { useState, type RefObject } from "react";
import { Html } from "@react-three/drei";
import { Quaternion, Vector3, type Object3D } from "three";
import type { DeviceDefinition, DeviceInstance } from "@/contracts/device";
import { resolveParameters } from "@/validation/contracts";
import { resolveInterfaceFrame } from "@/domain/resolveInterfaceFrame";
import { useWorkspace } from "@/stores/workspace";
export function InterfaceMarkers({
  definition,
  instance,
  occluder,
}: {
  definition: DeviceDefinition;
  instance: DeviceInstance;
  occluder: RefObject<Object3D>;
}) {
  const [active, setActive] = useState<string | null>(null);
  const parameters = resolveParameters(definition, instance.paramOverrides);
  return (
    <group name="interface-overlays">
      {definition.spatialInterfaces?.map((port) => {
        let frame;
        try {
          frame = resolveInterfaceFrame(port, definition, parameters);
        } catch {
          return null;
        }
        if (!frame) return null;
        const q = new Quaternion().setFromUnitVectors(
          new Vector3(0, 1, 0),
          new Vector3(...frame.forward),
        );
        return (
          <group key={port.interface_id} position={frame.position}>
            <Html center occlude={[occluder]} zIndexRange={[20, 0]}>
              <button
                type="button"
                className={`interface-dot ${active === port.interface_id ? "active" : ""}`}
                aria-label={`接口 ${port.name}`}
                data-interface-id={port.interface_id}
                data-local-position={frame.position.join(",")}
                title={`${port.name} · ${port.interface_id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setActive(port.interface_id);
                  useWorkspace.setState({
                    selectedInterface: port.interface_id,
                  });
                  document
                    .getElementById(`interface-${port.interface_id}`)
                    ?.scrollIntoView({ block: "nearest" });
                }}
              >
                <span className="interface-tooltip">{port.name}</span>
              </button>
            </Html>
            {active === port.interface_id && (
              <group quaternion={q}>
                <mesh position={[0, 0.07, 0]}>
                  <cylinderGeometry args={[0.004, 0.004, 0.14, 6]} />
                  <meshBasicMaterial color="#f39a4b" />
                </mesh>
                <mesh position={[0, 0.16, 0]}>
                  <coneGeometry args={[0.018, 0.05, 8]} />
                  <meshBasicMaterial color="#f39a4b" />
                </mesh>
              </group>
            )}
          </group>
        );
      })}
    </group>
  );
}

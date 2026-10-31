import { useSyncExternalStore } from "react";
import { runtimeController } from "@/services/RuntimeController";
export function RobotDebugOverlay() {
  const s = useSyncExternalStore(
    runtimeController.subscribe,
    runtimeController.snapshot,
    runtimeController.snapshot,
  );
  if (!s.robot || !["ready", "running", "paused"].includes(s.status))
    return null;
  return (
    <group position={s.robot.tcp.position} quaternion={s.robot.tcp.rotation}>
      <axesHelper args={[0.15]} />
      <mesh>
        <sphereGeometry args={[0.014, 12, 8]} />
        <meshBasicMaterial color="#ffad55" depthTest={false} />
      </mesh>
    </group>
  );
}

import type { RuntimeSnapshot } from "@/contracts/runtime";
export function RuntimeMaterialView({
  snapshot: s,
}: {
  snapshot: RuntimeSnapshot;
}) {
  if (s.materialInstanceId || !s.pose || !s.size) return null;
  return (
    <mesh
      name="runtime-experiment-box"
      position={s.pose.position}
      quaternion={s.pose.rotation}
      castShadow
      receiveShadow
    >
      <boxGeometry args={s.size} />
      <meshStandardMaterial color="#e9b95e" roughness={0.7} />
    </mesh>
  );
}

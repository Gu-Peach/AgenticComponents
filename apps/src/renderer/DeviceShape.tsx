import type { DeviceType, Vec3 } from "@/contracts/device";
function Box({
  at,
  size,
  color = "#6e8497",
}: {
  at: Vec3;
  size: Vec3;
  color?: string;
}) {
  return (
    <mesh position={at} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} metalness={0.45} roughness={0.5} />
    </mesh>
  );
}
function Cylinder({
  at,
  radius,
  height,
  color = "#62788b",
  rotation,
}: {
  at: Vec3;
  radius: number;
  height: number;
  color?: string;
  rotation?: Vec3;
}) {
  return (
    <mesh position={at} rotation={rotation} castShadow>
      <cylinderGeometry args={[radius, radius, height, 24]} />
      <meshStandardMaterial color={color} metalness={0.55} roughness={0.4} />
    </mesh>
  );
}
export function DeviceShape({ type }: { type: DeviceType }) {
  if (type === "conveyor")
    return (
      <group>
        <Box at={[0, 0.86, 0]} size={[2.7, 0.12, 0.68]} color="#263747" />
        {[-1, 1].flatMap((x) =>
          [-1, 1].map((z) => (
            <Box
              key={`${x}${z}`}
              at={[x, 0.42, z * 0.27]}
              size={[0.07, 0.84, 0.07]}
            />
          )),
        )}
        {[-1, 1].map((z) => (
          <Box
            key={z}
            at={[0, 0.92, z * 0.39]}
            size={[2.85, 0.18, 0.06]}
            color="#328b9c"
          />
        ))}
        {Array.from({ length: 18 }, (_, i) => (
          <Cylinder
            key={i}
            at={[-1.25 + i * 0.147, 0.96, 0]}
            radius={0.055}
            height={0.67}
            rotation={[Math.PI / 2, 0, 0]}
            color="#9eacb5"
          />
        ))}
        <Box at={[0.6, 0.74, 0.46]} size={[0.3, 0.22, 0.2]} color="#344655" />
      </group>
    );
  if (type === "robot_arm")
    return (
      <group>
        <Box at={[0, 0.08, 0]} size={[0.85, 0.16, 0.85]} color="#283744" />
        <Cylinder
          at={[0, 0.3, 0]}
          radius={0.27}
          height={0.38}
          color="#e7a24b"
        />
        <Cylinder
          at={[0, 0.56, 0]}
          radius={0.22}
          height={0.42}
          rotation={[Math.PI / 2, 0, 0]}
          color="#283744"
        />
        <group position={[0, 0.56, 0]} rotation={[0, 0, -0.45]}>
          <Box at={[0, 0.48, 0]} size={[0.27, 0.96, 0.29]} color="#edaa4e" />
          <Cylinder
            at={[0, 0.95, 0]}
            radius={0.19}
            height={0.38}
            rotation={[Math.PI / 2, 0, 0]}
            color="#324657"
          />
          <group position={[0, 0.95, 0]} rotation={[0, 0, 1.5]}>
            <Box at={[0, 0.4, 0]} size={[0.22, 0.8, 0.23]} color="#edaa4e" />
            <Cylinder
              at={[0, 0.85, 0]}
              radius={0.15}
              height={0.26}
              color="#3b4f5c"
            />
            <Box
              at={[-0.13, 1.03, 0]}
              size={[0.06, 0.23, 0.1]}
              color="#9aabb7"
            />
            <Box
              at={[0.13, 1.03, 0]}
              size={[0.06, 0.23, 0.1]}
              color="#9aabb7"
            />
          </group>
        </group>
      </group>
    );
  if (type === "lift_table")
    return (
      <group>
        <Box at={[0, 0.08, 0]} size={[1, 0.16, 0.85]} color="#34495a" />
        {[-1, 1].map((n) => (
          <group key={n} position={[0, 0.38, n * 0.28]}>
            <group rotation={[0, 0, 0.7]}>
              <Box at={[0, 0, 0]} size={[0.07, 0.78, 0.07]} color="#e4aa56" />
            </group>
            <group rotation={[0, 0, -0.7]}>
              <Box at={[0, 0, 0]} size={[0.07, 0.78, 0.07]} color="#e4aa56" />
            </group>
          </group>
        ))}
        <Box at={[0, 0.72, 0]} size={[1.15, 0.12, 0.95]} color="#8a9da9" />
      </group>
    );
  if (type === "rotary_table")
    return (
      <group>
        <Cylinder
          at={[0, 0.28, 0]}
          radius={0.4}
          height={0.56}
          color="#2d4352"
        />
        <Cylinder
          at={[0, 0.67, 0]}
          radius={0.7}
          height={0.18}
          color="#428fa0"
        />
        <Box at={[0, 0.77, 0]} size={[1.1, 0.03, 0.03]} color="#e4b960" />
      </group>
    );
  if (type === "storage_rack")
    return (
      <group>
        {[-1, 1].flatMap((x) =>
          [-1, 1].map((z) => (
            <Box
              key={`${x}${z}`}
              at={[x * 0.85, 1.3, z * 0.4]}
              size={[0.08, 2.6, 0.08]}
              color="#3e859b"
            />
          )),
        )}
        {[0.12, 1, 1.9, 2.6].map((y) => (
          <group key={y}>
            <Box at={[0, y, 0]} size={[1.85, 0.08, 0.9]} color="#708492" />
            <Box at={[0, y, -0.45]} size={[1.85, 0.15, 0.05]} color="#dda250" />
          </group>
        ))}
        {[-0.5, 0.4].map((x) => (
          <Box
            key={x}
            at={[x, 1.22, 0]}
            size={[0.65, 0.35, 0.6]}
            color="#c6b693"
          />
        ))}
      </group>
    );
  if (type === "material_source_station")
    return (
      <group>
        <Box at={[0, 0.53, 0]} size={[0.85, 1.06, 0.9]} color="#627f90" />
        <Box at={[0, 1.09, 0]} size={[1, 0.06, 1]} color="#a3b1b9" />
        <Box at={[0.44, 0.8, 0]} size={[0.03, 0.28, 0.45]} color="#213646" />
        <Box at={[0, 1.3, 0]} size={[0.45, 0.35, 0.5]} color="#c5ae83" />
      </group>
    );
  if (type === "workpiece")
    return <Box at={[0, 0.14, 0]} size={[0.32, 0.28, 0.38]} color="#dfb76f" />;
  return (
    <group>
      {[-0.35, 0, 0.35].map((x) => (
        <Box
          key={x}
          at={[x, 0.09, 0]}
          size={[0.12, 0.18, 0.85]}
          color="#937b5e"
        />
      ))}
      {[-0.32, -0.16, 0, 0.16, 0.32].map((z) => (
        <Box key={z} at={[0, 0.21, z]} size={[1, 0.07, 0.13]} color="#b5a080" />
      ))}
    </group>
  );
}

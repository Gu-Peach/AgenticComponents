import {
  Boxes,
  Box,
  Container,
  Factory,
  Layers3,
  MoveVertical,
  Rotate3D,
  Bot,
  ArrowRightLeft,
} from "lucide-react";
import type { DeviceType } from "@/contracts/device";
export const icons = {
  conveyor: ArrowRightLeft,
  lift_table: MoveVertical,
  material_source_station: Factory,
  robot_arm: Bot,
  rotary_table: Rotate3D,
  storage_rack: Container,
  workpiece: Box,
  workpiece_carrier: Layers3,
};
export function DeviceIcon({
  type,
  size = 18,
}: {
  type?: DeviceType;
  size?: number;
}) {
  const Icon = type ? icons[type] : Boxes;
  return <Icon size={size} strokeWidth={1.6} />;
}

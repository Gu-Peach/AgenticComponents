/** 将轨道位置或具名工位换算为轴坐标并检查行程，发布轨道实测位置和速度，同时提供滑轨与升降台共用的轴运动任务。 */

import { WarehouseActionAdapter } from "@/runtime/adapters/scene/WarehouseActionAdapter";
import {
  axisJob,
  type LinearAxisTrajectory,
} from "@/runtime/mechanisms/LinearAxisTrajectory";
export interface RailDriveBinding {
  id: string;
  drive: LinearAxisTrajectory;
  namedTarget: (key: string) => number;
  move: (position: number) => void;
  at: (position: number) => boolean;
  cancel: () => void;
  stopped: () => boolean;
  actual: () => number;
}
export class LinearRailSceneAdapter extends WarehouseActionAdapter {
  constructor(scene: string, run: string, binding: RailDriveBinding) {
    super(
      binding.id,
      scene,
      run,
      ["move_to_location", "move_to_position", "stop_motion"],
      (r) => {
        const stop = r.behavior === "stop_motion";
        const target = stop
          ? binding.drive.position
          : r.behavior === "move_to_location"
            ? binding.namedTarget(String(r.arguments.target))
            : Number((r.arguments.position_m as { value: number })?.value);
        if (
          !Number.isFinite(target) ||
          target < binding.drive.limits[0] ||
          target > binding.drive.limits[1]
        )
          throw new Error("Invalid rail target");
        return axisJob(
          binding.drive,
          target,
          stop,
          binding.move,
          binding.at,
          binding.cancel,
        );
      },
      binding.stopped,
      () => ({
        actual_position: binding.actual(),
        actual_speed: binding.drive.velocity,
      }),
    );
  }
}

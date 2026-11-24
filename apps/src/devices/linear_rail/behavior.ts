/** 将轨道位置或具名工位换算为轴坐标并检查行程，发布轨道实测位置和速度，同时提供滑轨与升降台共用的轴运动任务。 */

import { WarehouseActionAdapter } from "@/runtime/adapters/scene/WarehouseActionAdapter";
import {
  axisJob,
  type DeviceMountService,
} from "@/runtime/services/DeviceMountService";
import type { WarehouseLocation } from "@/contracts/warehouse";
import { resolveDock } from "@/domain/runtime/DockingTargetResolver";
export class LinearRailSceneAdapter extends WarehouseActionAdapter {
  constructor(
    scene: string,
    run: string,
    mount: DeviceMountService,
    locations: ReadonlyMap<string, WarehouseLocation>,
  ) {
    super(
      mount.config.rail,
      scene,
      run,
      ["move_to_location", "move_to_position", "stop_motion"],
      (r) => {
        const stop = r.behavior === "stop_motion",
          l = locations.get(String(r.arguments.target));
        const target = stop
          ? mount.rail.position
          : r.behavior === "move_to_location"
            ? l
              ? resolveDock(mount.config, l).rail
              : NaN
            : Number((r.arguments.position_m as { value: number })?.value);
        if (
          !Number.isFinite(target) ||
          target < mount.config.railLimits[0] ||
          target > mount.config.railLimits[1]
        )
          throw new Error("Invalid rail target");
        return axisJob(mount, "rail", target, stop);
      },
      () => mount.stopped,
      () => ({
        actual_position: mount.actual("rail"),
        actual_speed: mount.rail.velocity,
      }),
    );
  }
}

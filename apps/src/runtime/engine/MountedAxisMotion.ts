/** 用每个刚体经过的直线轴链计算一次世界位姿；可挂接滑座、机构或其他兼容设备。 */
import { Vector3 } from "three";
import type { BodyPose, PhysicsPort } from "@/contracts/physics";
import type { Vec3 } from "@/contracts/scene-execution";
import type { LinearAxisTrajectory } from "@/runtime/mechanisms/LinearAxisTrajectory";

export interface MountedAxis {
  direction: Vec3;
  drive: LinearAxisTrajectory;
}

export class MountedAxisMotion {
  private readonly drives = new Set<LinearAxisTrajectory>();
  private bodies: {
    id: string;
    rest: BodyPose;
    axes: readonly MountedAxis[];
  }[] = [];
  constructor(private physics: PhysicsPort) {}

  bind(body: string, axes: readonly MountedAxis[]) {
    if (this.bodies.some((b) => b.id === body))
      throw new Error("Duplicate mounted body: " + body);
    if (
      new Set(axes.map((a) => a.drive)).size !== axes.length ||
      axes.some(
        (a) =>
          !a.direction.every(Number.isFinite) ||
          Math.abs(Math.hypot(...a.direction) - 1) > 1e-6,
      )
    )
      throw new Error("Invalid mounted axis chain: " + body);
    const rest = this.physics.readBody!(body);
    for (const axis of axes) this.drives.add(axis.drive);
    this.bodies.push({ id: body, rest, axes: [...axes] });
    return rest;
  }

  step(dt: number) {
    for (const drive of this.drives) drive.step(dt);
    for (const { id, rest, axes } of this.bodies) {
      const target = new Vector3(...rest.position);
      for (const { direction, drive } of axes)
        target.addScaledVector(new Vector3(...direction), drive.position);
      this.physics.moveKinematicBody!(
        id,
        { ...rest, position: target.toArray() },
        dt,
      );
    }
  }
}

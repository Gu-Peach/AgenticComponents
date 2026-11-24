/** 物料局部抓取帧、刚体参考旋转，以及在支承面输送时的姿态约束。 */
import type { Vec3, Quat } from "./physics";

export interface MaterialGraspFrames {
  rest: Quat;
  preferred?: string;
  points: Record<string, { offset: Vec3; outward: Vec3 }>;
}
export interface TransportPosePolicy {
  contactFrame: string;
  axisLocal: Vec3;
  axisWorld: Vec3;
  maxTiltRad: number;
}

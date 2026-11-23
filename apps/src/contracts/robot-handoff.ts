import type { Vec3, Quat } from "./physics";

export interface HandoffConfig {
  jobs: { id: string; material: string; input: string; target: string }[];
  source: string;
  infeed: string;
  outfeed: string;
  giver: string;
  receiver: string;
  rendezvous: string;
  outfeedAxis: Vec3;
  maxTiltRad: number;
  materialFrames: Map<
    string,
    {
      rest: Quat;
      points: Record<string, { offset: Vec3; outward: Vec3 }>;
    }
  >;
  approachAxes: Map<string, Vec3>;
}

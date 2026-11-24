import type { Vec3 } from "./physics";

export interface IndexedProcessingConfig {
  jobs: { id: string; material: string; input: string; target: string }[];
  human: string;
  table: string;
  robot: string;
  source: string;
  slot: string;
  /** Encoder coordinates for the fixture at the two declared docking stations. */
  indexing: { home: number; process: number; stations: readonly number[] };
  pivot: Vec3;
  axis: Vec3;
  humanBody: string;
  handBody: string;
  humanArm: { shoulder: number; elbow: number; wrist: number; palmHome: Vec3 };
  tableBody: string;
  sourceBody: string;
  /** Measured from the pivot to the loading-side support at the rest angle. */
  slotOffset: Vec3;
  materialFrames: Map<
    string,
    {
      grasp: { offset: Vec3; outward: Vec3 };
      process: { offset: Vec3; outward: Vec3 };
      graspInterface: string;
      processInterface: string;
    }
  >;
  toolInterface: string;
  recipe: string;
  toolAxis: Vec3;
}

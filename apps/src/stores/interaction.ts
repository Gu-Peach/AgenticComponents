import { create } from "zustand";
import type { Transform } from "@/contracts/device";
import type { SnapCandidate } from "@/domain/spatial/snap";
export const useInteraction = create<{
  mode: "translate" | "rotate";
  suppressClickUntil: number;
  snapEnabled: boolean;
  drag: { instanceId: string; transform: Transform } | null;
  candidate: SnapCandidate | null;
}>(() => ({
  mode: "translate",
  suppressClickUntil: 0,
  snapEnabled: true,
  drag: null,
  candidate: null,
}));

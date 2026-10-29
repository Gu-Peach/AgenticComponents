import { useSyncExternalStore } from "react";
import { preview } from "@/runtime/services";
export function usePreview() {
  return useSyncExternalStore(
    preview.subscribe,
    preview.getSnapshot,
    preview.getSnapshot,
  );
}

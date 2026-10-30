import { useSyncExternalStore } from "react";
import { runtimeController } from "@/services/RuntimeController";
import { RuntimeMaterialView } from "./RuntimeMaterialView";
export function RuntimeSceneBridge() {
  const s = useSyncExternalStore(
    runtimeController.subscribe,
    runtimeController.snapshot,
    runtimeController.snapshot,
  );
  return <RuntimeMaterialView snapshot={s} />;
}

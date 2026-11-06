import type { SceneRuntimeSnapshot } from "@/runtime/engine/SceneRuntimeProgram";
export function sceneSignalDisplay(
  snapshot: SceneRuntimeSnapshot | undefined,
  sceneInstanceId: string,
  device: string,
  port: string,
) {
  const sample =
    snapshot?.sceneInstanceId === sceneInstanceId
      ? snapshot.signals.samples[`${sceneInstanceId}/${device}/${port}`]
      : undefined;
  if (!snapshot || !sample || sample.runId !== snapshot.runId)
    return { text: "—", quality: "unknown", tick: undefined };
  return {
    text: sample.quality === "good" ? String(sample.value) : "—",
    quality: sample.quality,
    tick: sample.sampledTick,
  };
}

import type { PreviewController } from "./PreviewController";
export function startPreviewClock(controller: PreviewController) {
  let last = 0,
    accumulator = 0,
    handle = 0;
  const frame = (now: number) => {
    if (!document.hidden && controller.getSnapshot().status === "running") {
      accumulator += Math.min(last ? (now - last) / 1000 : 0, 0.1);
      while (accumulator >= 1 / 60) {
        controller.tick(1 / 60);
        accumulator -= 1 / 60;
      }
    } else accumulator = 0;
    last = now;
    handle = requestAnimationFrame(frame);
  };
  const visibility = () => {
    last = 0;
    accumulator = 0;
    if (document.hidden) controller.pause();
  };
  document.addEventListener("visibilitychange", visibility);
  handle = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(handle);
    document.removeEventListener("visibilitychange", visibility);
  };
}

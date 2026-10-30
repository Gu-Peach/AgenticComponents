export function startRuntimeClock(
  step: (dt: number) => void,
  isRunning: () => boolean,
  pause: () => void,
) {
  let last = 0,
    acc = 0,
    frame = 0;
  const next = (now: number) => {
    if (!document.hidden && isRunning()) {
      acc += Math.min(last ? (now - last) / 1000 : 0, 0.1);
      let count = 0;
      while (acc >= 1 / 60 && count++ < 6) {
        step(1 / 60);
        acc -= 1 / 60;
      }
    } else acc = 0;
    last = now;
    frame = requestAnimationFrame(next);
  };
  const hidden = () => {
    last = 0;
    acc = 0;
    if (document.hidden) pause();
  };
  document.addEventListener("visibilitychange", hidden);
  frame = requestAnimationFrame(next);
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", hidden);
  };
}

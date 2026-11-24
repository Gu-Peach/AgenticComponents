/** 将浏览器动画帧的时间按播放倍率换算为固定仿真步，提供帧间插值比例，并在页面隐藏时触发暂停。 */

const fixedStep = 1 / 60;
export const MIN_PLAYBACK_RATE = 0.1;
export const MAX_PLAYBACK_RATE = 4;

/** Simulation seconds per wall-clock second for a scene toolbar multiplier. */
export const sceneClockRate = (multiplier: number) => 4 * multiplier;

interface ClockOptions {
  rate: () => number;
  onFrame: (fraction: number) => void;
}

export function startRuntimeClock(
  step: (dt: number) => void,
  isRunning: () => boolean,
  pause: () => void,
  options?: ClockOptions,
) {
  let last: number | undefined;
  let acc = 0,
    frame = 0;
  const reset = () => {
    last = undefined;
    acc = 0;
  };
  const next = (now: number) => {
    if (!document.hidden && isRunning()) {
      const elapsed = last === undefined ? 0 : Math.max(0, (now - last) / 1000);
      const rate = options?.rate() ?? 1;
      acc += Math.min(elapsed, 0.1) * rate;
      // Keep the old six-tick allowance at the new 1×. Faster playback can
      // consume up to 25 ms of wall time per frame, subject to the CPU budget.
      const maxSteps = Math.max(6, Math.ceil((0.025 * rate) / fixedStep));
      const started = performance.now();
      let count = 0;
      while (acc + 1e-10 >= fixedStep && count < maxSteps && isRunning()) {
        step(fixedStep);
        acc = Math.max(0, acc - fixedStep);
        count++;
        // Leave time for input and drawing when a scene step is expensive.
        if (options && performance.now() - started >= 8) break;
      }
      // Drop excess wall-clock debt. The simulation only advances by ticks actually executed.
      if (acc >= fixedStep) acc %= fixedStep;
      options?.onFrame(isRunning() ? acc / fixedStep : 1);
      last = now;
    } else reset();
    frame = requestAnimationFrame(next);
  };
  const hidden = () => {
    reset();
    if (document.hidden) pause();
  };
  document.addEventListener("visibilitychange", hidden);
  frame = requestAnimationFrame(next);
  return Object.assign(
    () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", hidden);
    },
    { reset },
  );
}

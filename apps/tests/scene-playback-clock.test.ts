import { afterEach, expect, it, vi } from "vitest";
import {
  sceneClockRate,
  startRuntimeClock,
} from "../src/runtime/engine/RuntimeClock";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(rate = 1) {
  const events = Object.assign(new EventTarget(), { hidden: false });
  let frame: FrameRequestCallback;
  let now = 0,
    running = true,
    ticks = 0,
    fraction = 0;
  vi.stubGlobal("document", events);
  vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
    frame = next;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(performance, "now").mockReturnValue(0);
  const clock = startRuntimeClock(
    (dt) => {
      expect(dt).toBe(1 / 60);
      ticks++;
    },
    () => running,
    () => {
      running = false;
    },
    {
      rate: () => sceneClockRate(rate),
      onFrame: (alpha) => {
        fraction = alpha;
      },
    },
  );
  const draw = (delta: number) => {
    now += delta;
    frame(now);
  };
  draw(0);
  return {
    draw,
    events,
    clock,
    ticks: () => ticks,
    fraction: () => fraction,
    rate: (r: number) => {
      rate = r;
    },
    resume: () => {
      running = true;
      clock.reset();
    },
  };
}

it.each([
  [0.1, 24],
  [0.25, 60],
  [0.5, 120],
  [1, 240],
  [1.75, 420],
  [4, 960],
])("keeps fixed physical steps at %s×", (rate, total) => {
  const c = setup(rate);
  for (let i = 0; i < 60; i++) c.draw(1000 / 60);
  expect(c.ticks()).toBe(total);
  c.clock();
});
it("interpolates between slow ticks, applies new speed and resumes without hidden-time catch-up", () => {
  const c = setup(0.125);
  c.draw(1000 / 60);
  expect(c.ticks()).toBe(0);
  expect(c.fraction()).toBeCloseTo(0.5);
  c.rate(0.375);
  c.draw(1000 / 60);
  expect(c.ticks()).toBe(2);
  c.events.hidden = true;
  c.events.dispatchEvent(new Event("visibilitychange"));
  c.draw(10000);
  c.events.hidden = false;
  c.resume();
  c.draw(8000);
  expect(c.ticks()).toBe(2);
  c.draw(1000 / 60);
  expect(c.ticks()).toBe(3);
  c.clock();
});
it("bounds catch-up after a long frame without skipping through a physical step", () => {
  const c = setup(1);
  c.draw(500);
  expect(c.ticks()).toBe(6);
  c.draw(1000 / 60);
  expect(c.ticks()).toBe(10);
  c.clock();
});

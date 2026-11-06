import { it, expect, vi } from "vitest";
import {
  SceneWorldStepper,
  type SceneDeviceDriver,
} from "../src/runtime/engine/SceneWorldStepper";
it("steps a single shared world between all before/after callbacks", () => {
  const log: string[] = [];
  const driver = (id: string): SceneDeviceDriver => ({
    id,
    beforePhysics: () => {
      log.push(id + " before");
    },
    afterPhysics: () => {
      log.push(id + " after");
    },
    requestStop: vi.fn(),
    isStopped: () => true,
    dispose: vi.fn(),
  });
  const world = {
    step: () => {
      log.push("physics");
    },
    dispose: vi.fn(),
  };
  const kernel = new SceneWorldStepper(world, [driver("R1"), driver("C1")]);
  kernel.start();
  kernel.step(1 / 60);
  expect(log).toEqual([
    "R1 before",
    "C1 before",
    "physics",
    "R1 after",
    "C1 after",
  ]);
  kernel.pause();
  kernel.step(1 / 60);
  expect(kernel.snapshot().tick).toBe(1);
  kernel.stop();
  kernel.step(1 / 60);
  expect(kernel.snapshot().status).toBe("stopped");
  kernel.dispose();
  kernel.dispose();
  expect(world.dispose).toHaveBeenCalledOnce();
});
it("retains unconfirmed stop state instead of claiming success or disposing physics", () => {
  const world = { step: vi.fn(), dispose: vi.fn() };
  const d: SceneDeviceDriver = {
    id: "R1",
    beforePhysics: vi.fn(),
    afterPhysics: vi.fn(),
    requestStop: vi.fn(),
    isStopped: () => false,
    dispose: vi.fn(),
  };
  const kernel = new SceneWorldStepper(world, [d], 2);
  kernel.start();
  kernel.stop();
  kernel.step(1 / 60);
  kernel.step(1 / 60);
  expect(kernel.snapshot().status).toBe("attention_required");
  expect(() => kernel.dispose()).toThrow();
  expect(world.dispose).not.toHaveBeenCalled();
});
it("rejects duplicate devices and invalid logical steps", () => {
  const d: SceneDeviceDriver = {
    id: "R1",
    beforePhysics: vi.fn(),
    afterPhysics: vi.fn(),
    requestStop: vi.fn(),
    isStopped: () => true,
    dispose: vi.fn(),
  };
  expect(
    () => new SceneWorldStepper({ step: vi.fn(), dispose: vi.fn() }, [d, d]),
  ).toThrow();
  expect(() =>
    new SceneWorldStepper({ step: vi.fn(), dispose: vi.fn() }, []).step(0.5),
  ).toThrow();
});

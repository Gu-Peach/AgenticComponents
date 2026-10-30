import type { DeviceTemplate } from "@/contracts/device-template";
import { ramp } from "@/runtime/mechanisms/SpeedRamp";
import { ConveyorState } from "./ConveyorState";
export const ConveyorTemplate: DeviceTemplate = {
  id: "conveyor.continuous-contact",
  version: "1",
  create(config) {
    const state = new ConveyorState();
    return {
      beforePhysics(dt, signals, physics) {
        const target = signals.read("runTag")
          ? Number(signals.read("speedTag"))
          : 0;
        state.speed = ramp(
          state.speed,
          target,
          dt,
          config.referenceSpeed,
          config.accelTime,
          config.decelTime,
        );
        physics.setSurfaceSpeed(state.speed);
      },
      afterPhysics(ctx) {
        const distance = state.encoder.step(ctx.appliedSpeed, ctx.dt);
        for (const [id, value] of Object.entries({
          actual_speed: ctx.appliedSpeed,
          runningTag: Math.abs(ctx.appliedSpeed) > config.speedTolerance,
          encoderTag: distance,
          device_ready: true,
          subject_on_conveyor: ctx.support,
          part_ready: ctx.atExit,
          entry_region_clear: ctx.entryClear,
          capacity_available: ctx.entryClear,
          accepted:
            ctx.request?.status === "busy" ||
            ctx.request?.status === "succeeded",
          done: ctx.request?.status === "succeeded",
          busy: ctx.request?.status === "busy",
          error: ctx.request?.status === "failed",
        }))
          ctx.publish(id, value);
      },
      dispose() {},
    };
  },
};

/** 定义场景调度器调用设备的接口，涵盖动作预检、提交、取消、停止，以及读取设备信号、执行回执和观测值。 */

import type { ActionRequest, ActionFeedback } from "@/contracts/scheduler";
import type { SignalWrite, SceneSignalFrame } from "@/contracts/scene-signals";
import type { SceneDeviceDriver } from "@/runtime/engine/SceneWorldStepper";
import type { ObservationWrite } from "@/runtime/signals/ObservationRegistry";

/** Only registered implementations implement this port. Schema descriptions are never executed. */
export interface DeviceActionPort extends SceneDeviceDriver {
  supports(behavior: string): boolean;
  /** Sample the preceding PLC scan, including command withdrawal and reset. */
  sampleInputs?(frame: Readonly<SceneSignalFrame>): void;
  /** Pure preflight. No physical movement or writes before the whole batch validates. */
  prepare(
    request: ActionRequest,
    frame: Readonly<SceneSignalFrame>,
  ): readonly SignalWrite[];
  prepareCancel(
    request: ActionRequest,
    frame: Readonly<SceneSignalFrame>,
  ): readonly SignalWrite[];
  prepareStop(frame: Readonly<SceneSignalFrame>): readonly SignalWrite[];
  submit(request: ActionRequest): void;
  cancel(request: ActionRequest): void;
  drainFeedback(): readonly ActionFeedback[];
  /** Gateway acknowledgement after a correlated acceptance; never starts another action. */
  acknowledge?(
    feedback: ActionFeedback,
    frame: Readonly<SceneSignalFrame>,
  ): readonly SignalWrite[];
  drainSignals(): readonly SignalWrite[];
  drainObservations?(): readonly ObservationWrite[];
}

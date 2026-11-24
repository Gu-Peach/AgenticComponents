/** 按设备实例保存最新的预览观测快照，并在发布或清空观测时通知订阅者。 */

import type { ParamValue } from "@/contracts/device";
/** Populate from the future sensor/runtime integration, never from project metadata. */
export class ObservationSource {
  private snapshots = new Map<string, Record<string, ParamValue>>();
  private empty = Object.freeze({});
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  publish(instanceId: string, snapshot: Record<string, ParamValue>) {
    this.snapshots.set(instanceId, Object.freeze({ ...snapshot }));
    this.listeners.forEach((fn) => fn());
  }
  read = (instanceId: string): Record<string, ParamValue> =>
    this.snapshots.get(instanceId) ?? this.empty;
  clear() {
    this.snapshots.clear();
    this.listeners.forEach((fn) => fn());
  }
}

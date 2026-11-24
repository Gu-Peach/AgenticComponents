/** 创建空闲状态的初始快照，为尚未运行的设备提供零时刻和空信号等默认值。 */

import type { RuntimeSnapshot } from "@/contracts/runtime";
export function emptySnapshot(): RuntimeSnapshot {
  return {
    status: "idle",
    tick: 0,
    time: 0,
    signals: {},
    supported: false,
    atExit: false,
    request: null,
  };
}

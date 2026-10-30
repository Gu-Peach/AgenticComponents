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

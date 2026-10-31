import type { RuntimeSnapshot } from "@/contracts/runtime";
export function RobotStatePanel({ state }: { state: RuntimeSnapshot }) {
  const r = state.robot;
  return (
    <div aria-live="polite">
      <p data-testid="robot-status">
        {state.status} · {r?.phase ?? "未准备"} · {state.time.toFixed(2)} s
      </p>
      {r && (
        <>
          <p data-testid="robot-joints">
            q: {r.q.map((v) => v.toFixed(3)).join(", ")}
          </p>
          <p data-testid="robot-tcp">
            TCP m: {r.tcp.position.map((v) => v.toFixed(3)).join(", ")}
          </p>
          <p>
            模式：{r.mode} · IK误差 {r.ik?.error.toFixed(4) ?? "—"} m
          </p>
          <p data-testid="robot-holding">
            持有：{r.holdingMaterialId ?? "无"} · 约束误差{" "}
            {r.constraintErrorM.toFixed(4)} m
          </p>
        </>
      )}
      <p data-testid="robot-request">
        任务：{state.request?.status ?? "无"} {state.request?.reason}
      </p>
      {state.error && <p role="alert">{state.error}</p>}
    </div>
  );
}

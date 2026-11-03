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
          {r.targets && (
            <div data-testid="robot-plan-targets">
              <p>
                取料TCP目标（世界 m）：
                {r.targets.pickTCP.map((n) => n.toFixed(3)).join(", ")}
              </p>
              <p>
                物料放置中心（世界 m）：
                {r.targets.placeCenter.map((n) => n.toFixed(3)).join(", ")}
              </p>
              <p>
                放料位置取所选传送带中心，并非最近端点；预检查通过后才启动任务。
              </p>
            </div>
          )}
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

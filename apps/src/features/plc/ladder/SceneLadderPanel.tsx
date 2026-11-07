import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ScenePackageInstance } from "@/contracts/scene-package";
import type { SceneLadderRung } from "@/contracts/scene-ladder";
import { compileSceneLadder } from "@/domain/runtime/compileSceneLadder";
import { conditionDecisionFor } from "@/domain/runtime/conditionDecisionFor";
import { selectSceneActivation } from "@/domain/runtime/selectSceneActivation";
import { sceneRuntimeController as controller } from "@/services/SceneRuntimeController";
import { SceneRunPanel } from "@/features/runtime/SceneRunPanel";
import { ConditionNetwork, TraceRows } from "./ConditionNetwork";
import styles from "./SceneLadder.module.css";
const phases = {
  precondition: "前置 · 准入时判定",
  authorization: "资源授权 · 候选获准后",
  sustaining: "执行中 · 持续监控",
  completion: "完成 · 本次请求证据",
  release: "释放义务",
  stopped: "停止条件 · 仍需匹配停止回执",
  finalization: "批次验收",
  gate: "控制门",
};
const states: Record<string, string> = {
  pending: "待进入",
  waiting_preconditions: "等待前置",
  waiting_resources: "等待资源",
  waiting_authorization: "等待授权",
  waiting_acceptance: "等待接受",
  running: "执行中",
  verifying_completion: "核对完成",
  succeeded: "已完成",
  stopping: "停止中",
  cancelled: "已取消",
  failed: "失败",
};
const Rung = memo(function Rung({
  rung,
  sceneId,
}: {
  rung: SceneLadderRung;
  sceneId: string;
}) {
  const ref = useRef<HTMLElement>(null),
    [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "200px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const runtime = useSyncExternalStore(
    visible ? controller.subscribe : () => () => {},
    () => (visible ? controller.snapshot(sceneId) : undefined),
    () => undefined,
  );
  const id =
      rung.kind === "join" || rung.kind === "finalization"
        ? rung.parentId!
        : rung.id,
    activation = selectSceneActivation(runtime?.process, id);
  const children = activation
    ? (runtime?.process.activations.filter(
        (a) => a.parentId === activation.id,
      ) ?? [])
    : [];
  const supplemental = Object.values(runtime?.conditions?.latest ?? {}).filter(
    (d) =>
      d.activationId === activation?.id &&
      (rung.kind === "finalization"
        ? d.phase === "finalization"
        : ["stopped", "release"].includes(d.phase)),
  );
  const displayState =
    rung.kind === "finalization" ? runtime?.process.status : activation?.state;
  const stateLabel =
    displayState === "pending" && children.length > 0 && !rung.device
      ? rung.kind === "join"
        ? "等待本轮分支汇合"
        : "执行子工步"
      : displayState
        ? (states[displayState] ?? displayState)
        : "未激活";
  const cfg = controller.configuration(sceneId),
    rawSubject = activation?.subjectId,
    subject =
      rawSubject &&
      ([...(cfg?.subjectIds ?? [])].find(
        ([, value]) => String(value) === rawSubject,
      )?.[0] ??
        rawSubject);
  return (
    <section ref={ref} className={styles.rung} aria-label={`梯级 ${rung.id}`}>
      <header className={styles.rungHeader}>
        <span className={styles.kind}>{rung.kind}</span>
        <strong>{rung.id}</strong>
        <span>
          {rung.device ? `${rung.device}.${rung.behavior}` : rung.label}
        </span>
        <span className={styles.state} data-state={activation?.state}>
          {stateLabel}
        </span>
      </header>
      {rung.device ? (
        <>
          <div className={styles.control}>
            <span className={styles.rail} />
            <span className={styles.token}>
              本轮流程令牌
              <br />
              {activation ? "已创建" : "未进入"}
            </span>
            <span>→</span>
            <div className={styles.controlBody}>
              <strong>
                {rung.device}.{rung.behavior}
              </strong>
              <br />
              行为执行实例 ·{" "}
              {activation
                ? (states[activation.state] ?? activation.state)
                : "未激活"}
            </div>
            <span>→</span>
            <span className={styles.token} data-state={activation?.state}>
              本轮完成锁存
              <br />
              {activation?.state === "succeeded"
                ? "true"
                : activation
                  ? "false"
                  : "未建立"}
            </span>
            <span className={styles.rail} />
          </div>
          <div className={styles.meta}>
            请求 {activation?.requestId ?? "—"} · 主体 {subject ?? "—"} · 发布
            tick {runtime?.tick ?? "—"} ·{" "}
            {rung.predecessor
              ? `等待前驱 ${rung.predecessor} 的本轮完成`
              : `由 ${rung.parentId ?? "流程入口"} 分发`}
            <br />
            <small>
              {activation?.id ?? "尚无本轮 activation"}
              {rung.source ? ` · ${rung.source.file}:${rung.source.line}` : ""}
            </small>
          </div>
          {!!activation?.blockedBy.length && (
            <p
              aria-label="工步阻塞原因"
              style={{ color: "#d9bb77", overflowWrap: "anywhere" }}
            >
              等待：{activation.blockedBy.join("；")}
            </p>
          )}
          {rung.conditions.map((condition) => {
            const decision = conditionDecisionFor(
              runtime?.conditions,
              rung.id,
              condition.phase,
              condition.key,
              activation?.id,
            );
            return (
              <div className={styles.condition} key={condition.key}>
                <div className={styles.conditionHeader}>
                  <span>{phases[condition.phase]}</span>
                  <code>{condition.key}</code>
                  <span>
                    {decision
                      ? `判定 @${decision.evaluatedTick} / 输入帧 @${decision.inputSampleTick}`
                      : "本轮未求值"}
                  </span>
                </div>
                <ConditionNetwork condition={condition} decision={decision} />
                {decision && (
                  <details>
                    <summary>
                      判定证据 ·{" "}
                      {decision.value === null
                        ? "未知"
                        : String(decision.value)}{" "}
                      · {decision.quality}
                    </summary>
                    <TraceRows nodes={decision.nodes} />
                  </details>
                )}
              </div>
            );
          })}
          {runtime && (
            <div className={styles.ports} aria-label={`${rung.id} 当前端口`}>
              当前端口 @ {runtime.tick}（与上方准入历史判定分开）
              {[
                "accepted",
                "busy",
                "done",
                "error",
                "result_id",
                "holding_material",
                "actual_speed",
              ].map((port) => {
                const s =
                  runtime.signals.samples[`${sceneId}/${rung.device}/${port}`];
                return s ? (
                  <span
                    key={port}
                    title={`质量 ${s.quality} · 样本 ${s.sampledTick} · 请求 ${s.requestId ?? "—"}`}
                  >
                    {port}:{" "}
                    <b>
                      {s.quality === "good"
                        ? typeof s.value === "number"
                          ? Number(s.value.toFixed(4))
                          : String(s.value)
                        : "?"}
                    </b>
                  </span>
                ) : null;
              })}
            </div>
          )}
        </>
      ) : (
        <div className={styles.control}>
          <span className={styles.rail} />
          <div className={styles.controlBody}>
            {rung.kind === "join" ? (
              <>
                <strong>AND · 同一激活的全部分支完成</strong>
                <div>
                  {rung.children.map((child) => {
                    const state = children
                      .filter((a) => a.node === child)
                      .at(-1);
                    return (
                      <span
                        className={styles.token}
                        data-state={state?.state}
                        key={child}
                      >
                        {child} ·{" "}
                        {state
                          ? (states[state.state] ?? state.state)
                          : "未激活"}
                      </span>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <strong>{rung.label}</strong>
                <div>
                  {rung.children.map((child, i) => (
                    <span className={styles.token} key={child}>
                      {rung.kind === "par"
                        ? "↳ "
                        : rung.kind === "seq"
                          ? `${i + 1}. `
                          : ""}
                      {child}
                    </span>
                  ))}
                </div>
                {rung.kind === "repeat" && (
                  <small>
                    当前轮次 {activation?.iteration ?? "—"} /{" "}
                    {activation?.totalIterations ?? "—"}；每轮独立请求与主体。
                  </small>
                )}
                {rung.kind === "branch" && (
                  <small>
                    本轮选择：{activation?.selectedChild ?? "尚未选择"}
                    ；未选支路不会获得执行令牌。
                  </small>
                )}
              </>
            )}
          </div>
          <span className={styles.rail} />
        </div>
      )}
      {supplemental.map((decision) => (
        <div className={styles.condition} key={decision.conditionKey}>
          <div className={styles.conditionHeader}>
            {phases[decision.phase]} · {decision.conditionKey} · 判定 @
            {decision.evaluatedTick}
          </div>
          <ConditionNetwork
            condition={{
              key: decision.conditionKey,
              device: rung.device ?? "",
              behavior: rung.behavior ?? "finalization",
              expected: true,
              phase: decision.phase,
              expr: {
                op: "opaque",
                source: "observation",
                key: decision.conditionKey,
              },
              bindings: {},
            }}
            decision={decision}
          />
          <details>
            <summary>实际停止 / 验收证据</summary>
            <TraceRows nodes={decision.nodes} />
          </details>
        </div>
      ))}
      {rung.kind === "finalization" && (
        <p>
          独立验收状态：{runtime?.process.status ?? "未开始"}
          ；流程末行执行完成不等同于批次验收通过。
        </p>
      )}
    </section>
  );
});
export function SceneLadderPanel({
  scene,
  onDevices,
}: {
  scene: ScenePackageInstance;
  onDevices: () => void;
}) {
  const compiled = useMemo(() => {
    try {
      return { graph: compileSceneLadder(scene.bundle) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [scene.bundle]);
  const runtime = useSyncExternalStore(
      controller.subscribe,
      () => controller.snapshot(scene.id),
      () => undefined,
    ),
    [events, setEvents] = useState(false);
  const history = events ? controller.signalHistory(scene.id) : undefined;
  const protocolEvents = history?.events
    .filter((e) =>
      /\/(accepted|execute|start_pick|done|error|result_id)$/.test(e.key),
    )
    .slice(-60);
  return (
    <div className={styles.panel} aria-label="场景实时梯形图">
      <div className={styles.toolbar}>
        <strong>{scene.bundle.name} · 工步梯形图</strong>
        <button onClick={onDevices}>设备接口详情</button>
        <button onClick={() => setEvents(!events)}>
          {events ? "收起事件" : "信号事件记录"}
        </button>
      </div>
      <SceneRunPanel scene={scene} />
      <p className={styles.legend}>
        只读监视 · 绿：判定成立 · 暗：不成立/未激活 ·
        虚线黄：未知证据。准入判断保留实际判定 tick；当前端口值另列。par
        是并发，AND 汇合等待本轮全部分支。
      </p>
      <div className={styles.meta}>
        条件引擎：{runtime?.conditions?.mode ?? "尚未准备"} · run{" "}
        {runtime?.runId ?? "—"} · tick {runtime?.tick ?? 0} ·{" "}
        {compiled.graph?.rungs.length ?? 0} 个梯级
      </div>
      {events && (
        <details open>
          <summary>实际信号变化 · 不延长脉冲</summary>
          <p>
            {history?.lost
              ? `事件环已淘汰早期记录，当前保留序号 ${history.events[0]?.sequence}—${history.lastSequence}`
              : "当前保留的信号事件"}
            ；条件转换环淘汰 {runtime?.conditions?.dropped ?? 0} 条。
          </p>
          <table className={styles.trace}>
            <thead>
              <tr>
                <th>序号/tick</th>
                <th>信号</th>
                <th>值/质量</th>
                <th>请求/激活</th>
              </tr>
            </thead>
            <tbody>
              {protocolEvents?.map((e) => (
                <tr key={e.sequence}>
                  <td>
                    {e.sequence} / {e.tick}
                  </td>
                  <td>{e.key}</td>
                  <td>
                    {String(e.sample.value)} / {e.sample.quality}
                  </td>
                  <td>
                    {e.sample.requestId} / {e.sample.activationId}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {compiled.error ? (
        <p role="alert">梯形图生成被阻止：{compiled.error}</p>
      ) : (
        compiled.graph?.rungs.map((rung) => (
          <Rung key={rung.id} rung={rung} sceneId={scene.id} />
        ))
      )}
    </div>
  );
}

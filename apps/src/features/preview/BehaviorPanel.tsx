import { hasPendingContactModel } from "@/contracts/conveyor";
import { useState, useSyncExternalStore } from "react";
import {
  Play,
  RotateCcw,
  FlaskConical,
  CircleCheck,
  CircleHelp,
  CircleX,
} from "lucide-react";
import type {
  DeviceDefinition,
  DeviceInstance,
  ParamValue,
} from "@/contracts/device";
import { usePreview } from "@/hooks/usePreview";
import { preview, executors, observations } from "@/runtime/services";
import { evaluateConditions } from "@/runtime/ConditionEvaluator";
import { resolveParameters } from "@/validation/contracts";
import { useWorkspace } from "@/stores/workspace";
import { isActive } from "@/contracts/preview";
import { reportError } from "@/commands/workspaceCommands";
import { ParameterField } from "@/components/ui/ParameterField";
export function BehaviorPanel({
  definition,
  instance,
}: {
  definition: DeviceDefinition;
  instance: DeviceInstance;
}) {
  const [behaviorId, setBehaviorId] = useState(
    definition.behaviors[0]?.id ?? "",
  );
  const [mock, setMock] = useState(false);
  const [args, setArgs] = useState<Record<string, ParamValue>>({});
  const state = usePreview();
  const behavior = definition.behaviors.find((b) => b.id === behaviorId);
  const active = isActive(state.status);
  const callable =
    behavior && ["action", "composite", "service"].includes(behavior.kind);
  const facts = useSyncExternalStore(
    observations.subscribe,
    () => observations.read(instance.instanceId),
    () => observations.read(instance.instanceId),
  );
  const conditions = behavior
    ? evaluateConditions(
        behavior.preconditions,
        resolveParameters(definition, instance.paramOverrides),
        facts,
        { local_preview: true },
      )
    : [];
  const registered = behavior && Boolean(executors.get(behavior.executorRef));
  const blocked =
    !mock &&
    (hasPendingContactModel(definition.typeSpecificContract) ||
      definition.spatialInterfaces?.some((p) => p.local_frame_pending) ||
      behavior?.implementationStatus === "pending_adapter" ||
      Boolean(behavior?.sustainingConditions?.length) ||
      !registered ||
      definition.template ||
      conditions.some((c) => c.state !== "satisfied") ||
      !behavior?.completionChecks.length);
  const owner = useWorkspace(
    (s) =>
      s.project?.instances.find(
        (i) => i.instanceId === state.request?.instanceId,
      )?.name,
  );
  return (
    <div className="behavior-panel">
      {definition.behaviors.length ? (
        <>
          <label className="field-label">行为契约</label>
          <select
            aria-label="选择设备行为"
            value={behaviorId}
            disabled={active}
            onChange={(e) => {
              setBehaviorId(e.target.value);
              setArgs({});
            }}
          >
            {definition.behaviors.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} · {b.kind}
              </option>
            ))}
          </select>
          <code className="behavior-id">{behavior?.id}</code>
          {behavior &&
            Object.entries(behavior.arguments).map(([key, spec]) => (
              <label className="field-row" key={key}>
                <span>{key}</span>
                <ParameterField
                  name={key}
                  spec={spec}
                  value={args[key] ?? spec.default}
                  disabled={active}
                  onCommit={(value) => setArgs((s) => ({ ...s, [key]: value }))}
                />
              </label>
            ))}
          <div className="conditions">
            <div className="subheading">
              前置条件 <small>实时观测待接入</small>
            </div>
            {conditions.map((c) => (
              <div className={`condition ${c.state}`} key={c.id}>
                {c.state === "satisfied" ? (
                  <CircleCheck size={13} />
                ) : c.state === "unknown" ? (
                  <CircleHelp size={13} />
                ) : (
                  <CircleX size={13} />
                )}
                <span>{c.label}</span>
                <small>
                  {c.state === "satisfied"
                    ? "满足"
                    : c.state === "unknown"
                      ? "未知"
                      : "不满足"}
                </small>
              </div>
            ))}
            {!conditions.length && <small>未声明前置条件</small>}
          </div>
          <p className="completion-note">完成依据：{behavior?.completion}</p>
          {callable ? (
            <>
              <label className="mock-toggle">
                <input
                  type="checkbox"
                  checked={mock}
                  disabled={active}
                  onChange={(e) => setMock(e.target.checked)}
                />
                <FlaskConical size={14} />
                演示模式 <small>MOCK</small>
              </label>
              {mock ? (
                <p className="warning-note">
                  仅验证调用、时钟和状态反馈，不执行真实设备动作，不证明前置条件成立。
                </p>
              ) : (
                <p className="muted-note">
                  {registered
                    ? "校验模型、前置条件和完成观测后可预览。"
                    : "真实动作执行器未接入，接口已预留。"}
                </p>
              )}
              <button
                className="primary full-width"
                disabled={active || blocked}
                onClick={() => {
                  const project = useWorkspace.getState().project!;
                  const defaults = Object.fromEntries(
                    Object.entries(behavior!.arguments)
                      .filter(([, s]) => s.default !== undefined)
                      .map(([k, s]) => [k, s.default!]),
                  );
                  preview
                    .start(
                      {
                        requestId: crypto.randomUUID(),
                        instanceId: instance.instanceId,
                        behaviorId,
                        definitionRevision: definition.revision,
                        sceneRevision: project.revision,
                        args: { ...defaults, ...args },
                        mode: mock ? "mock" : "real",
                      },
                      project,
                    )
                    .catch(reportError);
                }}
              >
                <Play size={14} />
                {active
                  ? `预览中 · ${owner}`
                  : mock
                    ? "启动演示预览"
                    : blocked
                      ? "待接入动作实现"
                      : "启动设备预览"}
              </button>
            </>
          ) : (
            <p className="muted-note">
              被动响应／观测由宿主产生，没有独立执行入口。
            </p>
          )}
          {state.request && (
            <div className="runtime-card">
              <div className="row space-between">
                <strong>
                  {state.request.mode === "mock"
                    ? "MOCK SESSION"
                    : "PREVIEW SESSION"}
                </strong>
                <span className="pill">{state.status}</span>
              </div>
              <div className="progress-track">
                <div style={{ width: `${state.progress * 100}%` }} />
              </div>
              <div className="row space-between">
                <small>
                  {owner} · {state.time.toFixed(2)} s
                </small>
                <small>{Math.round(state.progress * 100)}%</small>
              </div>
              {state.error && <p className="error-text">{state.error}</p>}
              <button
                className="text-button"
                disabled={
                  !state.supportsRestore ||
                  state.status === "preparing" ||
                  state.status === "stopping"
                }
                onClick={() => preview.restore().catch(reportError)}
              >
                <RotateCcw size={12} />
                恢复预览基线
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="muted-note">此设备未声明行为。</p>
      )}
    </div>
  );
}

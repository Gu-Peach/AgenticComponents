import { RobotSimulationPanel } from "@/features/runtime/RobotSimulationPanel";
import { SimulationPanel } from "@/features/runtime/SimulationPanel";
import { RuntimeSignalsPanel } from "@/features/runtime/RuntimeSignalsPanel";
import { resolveInterfaceFrame } from "@/domain/resolveInterfaceFrame";
import { useState, type ReactNode } from "react";
import { SlidersHorizontal, ChevronDown, Cuboid, Info } from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { DeviceIcon } from "@/components/ui/DeviceIcon";
import { ParameterField } from "@/components/ui/ParameterField";
import { BehaviorPanel } from "@/features/preview/BehaviorPanel";
import { typeLabels, type Vec3 } from "@/contracts/device";
import { resolveParameters, semanticIssues } from "@/validation/contracts";
import { usePreview } from "@/hooks/usePreview";
import { isActive } from "@/contracts/preview";
function Section({
  title,
  children,
  open = true,
  badge,
  sectionId,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
  badge?: string;
  sectionId?: string;
}) {
  return (
    <details id={sectionId} className="inspector-section" open={open}>
      <summary>
        <ChevronDown size={12} />
        {title}
        {badge && <small>{badge}</small>}
      </summary>
      <div className="section-content">{children}</div>
    </details>
  );
}
export function Inspector() {
  const {
    project,
    selectedId,
    modelErrors,
    modelNodes,
    inspectorTarget,
    selectedAsset,
    catalogDefinitions,
    selectedInterface,
    documentLocked,
  } = useWorkspace();
  const state = usePreview();
  const [error, setError] = useState("");
  const instance = project?.instances.find((i) => i.instanceId === selectedId);
  const def = project?.definitions.find((d) => d.specId === instance?.specId);
  const locked = isActive(state.status) || documentLocked;
  if (inspectorTarget === "catalog") {
    const asset =
      catalogDefinitions[selectedAsset ?? ""] ??
      project?.definitions.find((d) => d.specId === selectedAsset);
    return (
      <aside className="panel inspector">
        <div className="panel-heading">资产定义 · 只读</div>
        <div className="inspector-scroll">
          {asset ? (
            <>
              <h3>{asset.name}</h3>
              <p>
                {asset.specId} · {asset.revision}
              </p>
              <p className="muted-note">{asset.description}</p>
              {Object.entries(asset.paramsSchema).map(([key, spec]) => (
                <div className="parameter-row" key={key}>
                  <label title={spec.description}>
                    {key}
                    <small>{spec.description}</small>
                  </label>
                  <ParameterField
                    name={`定义 ${key}`}
                    spec={spec}
                    value={spec.default}
                    disabled
                    onCommit={() => {}}
                  />
                </div>
              ))}
              <Section title="空间接口">
                {asset.spatialInterfaces?.map((p) => (
                  <p key={p.interface_id}>
                    {p.name} · {p.local_frame?.position.join(", ") ?? "待标定"}
                  </p>
                ))}
              </Section>
            </>
          ) : (
            <p>正在读取设备定义…</p>
          )}
        </div>
      </aside>
    );
  }
  if (!instance || !def)
    return (
      <aside className="panel inspector">
        <div className="panel-heading">
          设备明细 <SlidersHorizontal size={14} />
        </div>
        <div className="empty-state">
          <Cuboid size={32} />
          <p>
            选择一个设备
            <br />
            查看参数、接口与行为
          </p>
        </div>
      </aside>
    );
  const values = resolveParameters(def, instance.paramOverrides);
  return (
    <aside className="panel inspector">
      <div className="panel-heading">
        <span>
          设备明细 <small>INSPECTOR</small>
        </span>
        <SlidersHorizontal size={14} />
      </div>
      <div className="inspector-scroll">
        <div className="device-heading">
          <div className={`device-heading-icon art-${def.deviceType}`}>
            <DeviceIcon type={def.deviceType} size={24} />
          </div>
          <div>
            <strong>{instance.name}</strong>
            <small>
              {typeLabels[def.deviceType]} / {def.revision}
            </small>
          </div>
        </div>
        <div className="device-chips">
          <span className="pill">{def.asset.assetId ? "GLB" : "示意模型"}</span>
          <span className="pill warning">
            {def.template ? "待配置模板" : "定义已加载"}
          </span>
        </div>
        {def.deviceType === "conveyor" && !def.template && (
          <Section title="接触式运行">
            <SimulationPanel />
            <RuntimeSignalsPanel />
          </Section>
        )}
        {def.deviceType === "robot_arm" &&
          def.source?.contract_version === "1.4" && (
            <Section title="机械臂运行">
              <RobotSimulationPanel />
            </Section>
          )}
        <div className="inspector-shortcuts">
          {[
            ["inspector-params", "参数"],
            ["inspector-behavior", "动作预览"],
            ["inspector-interfaces", "I/O 接口"],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => {
                const section = document.getElementById(id);
                if (section instanceof HTMLDetailsElement) {
                  section.open = true;
                  section.scrollIntoView({
                    block: "start",
                    behavior: "smooth",
                  });
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <Section title="基本信息">
          <label className="field-row">
            <span>名称</span>
            <input
              aria-label="设备名称"
              value={instance.name}
              onChange={(e) =>
                useWorkspace
                  .getState()
                  .updateInstance(instance.instanceId, { name: e.target.value })
              }
            />
          </label>
          <div className="id-line">
            <span>实例 ID</span>
            <code title={instance.instanceId}>{instance.instanceId}</code>
          </div>
          <label className="field-row">
            <span>可见</span>
            <input
              type="checkbox"
              checked={instance.visible}
              onChange={(e) =>
                useWorkspace.getState().updateInstance(instance.instanceId, {
                  visible: e.target.checked,
                })
              }
            />
          </label>
        </Section>
        <Section title="变换" badge="本地坐标">
          <div className="axis-head">
            <span />
            <span className="axis-x">X</span>
            <span className="axis-y">Y</span>
            <span className="axis-z">Z</span>
          </div>
          {(["position", "rotation", "scale"] as const).map((field) => (
            <div className="vector-row" key={field}>
              <span>
                {field === "position"
                  ? "位置 m"
                  : field === "rotation"
                    ? "旋转 °"
                    : "缩放"}
              </span>
              {instance.transform[field].map((v, index) => (
                <ParameterField
                  key={`${instance.instanceId}-${field}-${index}`}
                  name={`${field}-${"XYZ"[index]}`}
                  spec={{ type: "number" }}
                  disabled={locked}
                  value={Number(
                    (field === "rotation" ? (v * 180) / Math.PI : v).toFixed(3),
                  )}
                  onCommit={(value) => {
                    const n = Number(value);
                    if (!Number.isFinite(n) || (field === "scale" && n <= 0)) {
                      setError("变换需要有限数值，缩放必须大于零");
                      return;
                    }
                    const vector = [...instance.transform[field]] as Vec3;
                    vector[index] =
                      field === "rotation" ? (n * Math.PI) / 180 : n;
                    useWorkspace
                      .getState()
                      .updateInstance(instance.instanceId, {
                        transform: { ...instance.transform, [field]: vector },
                      });
                    setError("");
                  }}
                />
              ))}
            </div>
          ))}
        </Section>
        <Section
          sectionId="inspector-params"
          title="设备参数"
          badge={`${Object.keys(values).length} 字段`}
        >
          {locked && (
            <p className="muted-note">
              预览期间参数只读。在线设定值通道尚未接入。
            </p>
          )}
          {Object.entries(def.paramsSchema).map(([key, spec]) => (
            <div className="parameter-row" key={key}>
              <label title={spec.description}>
                {key}
                {spec.required && <span className="required">*</span>}
                <small>
                  {instance.paramOverrides[key] !== undefined
                    ? "实例覆盖"
                    : "定义默认"}
                  {spec.mutability === "runtime_setpoint" ? " · 设定值" : ""}
                </small>
              </label>
              <ParameterField
                name={key}
                spec={spec}
                value={values[key]}
                disabled={locked}
                onCommit={(value) => {
                  const overrides = {
                    ...instance.paramOverrides,
                    [key]: value,
                  };
                  const errors = semanticIssues(
                    def,
                    overrides,
                    ["1.3", "1.4"].includes(
                      String(def.source?.contract_version),
                    ),
                  );
                  if (errors.length) {
                    setError(errors.join("；"));
                    return;
                  }
                  useWorkspace.getState().updateInstance(instance.instanceId, {
                    paramOverrides: overrides,
                  });
                  setError("");
                }}
              />
            </div>
          ))}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
        </Section>
        <Section sectionId="inspector-behavior" title="行为与动作预览">
          <BehaviorPanel
            key={`${instance.instanceId}:${def.revision}`}
            definition={def}
            instance={instance}
          />
        </Section>
        <Section
          title="空间接口"
          badge={`${def.spatialInterfaces?.length ?? 0}`}
          open={Boolean(selectedInterface)}
        >
          {(def.spatialInterfaces ?? []).map((port) => (
            <details
              id={`interface-${port.interface_id}`}
              key={port.interface_id}
              open={selectedInterface === port.interface_id}
            >
              <summary>
                {port.name} · {port.capabilities.snap ? "吸附 " : ""}
              </summary>
              <p className="muted-note">
                {port.interface_id} ·{" "}
                {port.local_frame
                  ? `局部位置 ${port.local_frame.position.join(", ")}`
                  : port.local_frame_pending
                    ? "坐标待提供，暂不可吸附"
                    : (() => {
                        try {
                          return `派生位置 ${resolveInterfaceFrame(port, def, values)?.position.join(", ")}`;
                        } catch (e) {
                          return `接口无法求解：${e instanceof Error ? e.message : String(e)}`;
                        }
                      })()}
              </p>
            </details>
          ))}
          {!def.spatialInterfaces?.length && (
            <small>尚未声明统一空间接口；旧定义可从原始数据迁移。</small>
          )}
        </Section>
        <Section
          sectionId="inspector-interfaces"
          title="信号接口"
          badge={`${def.interfaces.length}`}
          open={false}
        >
          <p className="muted-note">
            设备级信号独立于空间接口；PLC 映射保存在实例上，运行值待引擎接入。
          </p>
          {def.interfaces.map((port) => (
            <div className="binding-row" key={port.id}>
              <span className={`direction ${port.direction}`}>
                {port.direction === "input" ? "IN" : "OUT"}
              </span>
              <div>
                <code>{port.id}</code>
                <small>
                  {port.valueType} · {port.description}
                </small>
                <input
                  aria-label={`绑定 ${port.id}`}
                  placeholder="未绑定 PLC 变量"
                  value={instance.bindings[port.id] ?? ""}
                  disabled={locked}
                  onChange={(e) =>
                    useWorkspace
                      .getState()
                      .updateInstance(instance.instanceId, {
                        bindings: {
                          ...instance.bindings,
                          [port.id]: e.target.value,
                        },
                      })
                  }
                />
              </div>
            </div>
          ))}
          {!def.interfaces.length && <small>未声明控制信号接口</small>}
        </Section>
        <Section title="模型节点与类型结构" open={false}>
          {modelErrors[instance.instanceId] && (
            <p className="error-text">{modelErrors[instance.instanceId]}</p>
          )}
          <p className="muted-note">
            {modelNodes[instance.instanceId]?.length ?? 0} 个已命名 GLB
            节点。节点映射及 TCP 配置由设备定义导入。
          </p>
          <div className="node-list">
            {modelNodes[instance.instanceId]?.map((name, i) => (
              <code key={`${i}-${name}`}>{name}</code>
            ))}
          </div>
          <pre className="contract-json">
            {JSON.stringify(def.typeSpecificContract, null, 2)}
          </pre>
        </Section>
        <Section title="定义诊断" open={false}>
          {def.diagnostics.map((message, i) => (
            <p className="muted-note" key={i}>
              <Info size={12} /> {message}
            </p>
          ))}
        </Section>
      </div>
    </aside>
  );
}

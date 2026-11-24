import { useState } from "react";
import type { DeviceInstance, ProjectDocument } from "@/contracts/device";
import type { RuntimeSnapshot } from "@/contracts/runtime";
import { decodeProcessNode, type ProcessNode } from "@/contracts/process-ir";
import { runtimeController } from "@/services/RuntimeController";
import { reportError } from "@/commands/workspaceCommands";

export function TransferWorkcellPanel({
  project,
  conveyor,
  material,
  locked,
  state,
}: {
  project: ProjectDocument;
  conveyor: DeviceInstance;
  material: DeviceInstance;
  locked: boolean;
  state: RuntimeSnapshot;
}) {
  const [arm, setArm] = useState(""),
    [support, setSupport] = useState("");
  const [custom, setCustom] = useState<{ name: string; root: ProcessNode }>();
  const candidates = (type: string, version: string) =>
    project.instances.filter(
      (i) =>
        i.visible &&
        project.definitions.some(
          (d) =>
            d.specId === i.specId &&
            d.revision === i.specRevision &&
            d.deviceType === type &&
            !d.template &&
            d.source?.contract_version === version,
        ),
    );
  const arms = candidates("robot_arm", "1.4"),
    supports = candidates("conveyor", "1.3");
  const chosen = arms.find((i) => i.instanceId === arm) ?? arms[0];
  const receiver = supports.find((i) => i.instanceId === support) ?? conveyor;
  return (
    <details>
      <summary>组合工艺 · 输送后抓放</summary>
      <label>
        取件机械臂
        <select
          aria-label="组合工艺机械臂"
          disabled={locked}
          value={chosen?.instanceId ?? ""}
          onChange={(e) => setArm(e.target.value)}
        >
          {!arms.length && <option value="">请添加机械臂模型</option>}
          {arms.map((i) => (
            <option key={i.instanceId} value={i.instanceId}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        放料支承面
        <select
          aria-label="组合工艺放料支承"
          disabled={locked}
          value={receiver.instanceId}
          onChange={(e) => setSupport(e.target.value)}
        >
          {supports.map((i) => (
            <option key={i.instanceId} value={i.instanceId}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        工艺 IR（可选）
        <input
          type="file"
          accept=".json"
          disabled={locked}
          onChange={async (e) => {
            const input = e.currentTarget,
              file = input.files?.[0];
            input.value = "";
            if (!file) return;
            try {
              const data = JSON.parse(await file.text());
              setCustom({
                name: file.name,
                root: decodeProcessNode(data?.body ?? data),
              });
            } catch (error) {
              setCustom(undefined);
              reportError(error);
            }
          }}
        />
      </label>
      {custom && (
        <button disabled={locked} onClick={() => setCustom(undefined)}>
          恢复默认工艺 · {custom.name}
        </button>
      )}
      <button
        disabled={locked || !chosen}
        onClick={() =>
          chosen &&
          void runtimeController
            .prepareTransfer(
              project,
              {
                conveyor: conveyor.instanceId,
                material: material.instanceId,
                robot: chosen.instanceId,
                support: receiver.instanceId,
              },
              custom?.root,
            )
            .catch(reportError)
        }
      >
        运行输送与取放
      </button>
      {state.workcell && (
        <>
          <p role="status">
            工艺 {state.workcell.status} · {state.workcell.step ?? "准备"}
          </p>
          <details>
            <summary>已绑定的工步信号</summary>
            {state.workcell.connections.map((e) => (
              <p
                key={[e.consumer, e.semantic, e.subject, e.endpoint].join("/")}
              >
                {e.producer ?? "初始观测"} → {e.consumer} · {e.semantic}(
                {e.subject}, {e.endpoint})
              </p>
            ))}
          </details>
        </>
      )}
    </details>
  );
}

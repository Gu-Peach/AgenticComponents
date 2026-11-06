import { useMemo } from "react";
import type { ProcessNode } from "@/contracts/process-ir";
import { decodeProcessNode } from "@/contracts/process-ir";
import type { ScenePackageInstance } from "@/contracts/scene-package";
import type { SceneRuntimeSnapshot } from "@/runtime/engine/SceneRuntimeProgram";
export function SceneProcessOutline({
  scene,
  runtime,
}: {
  scene: ScenePackageInstance;
  runtime?: SceneRuntimeSnapshot;
}) {
  const root = useMemo(
    () => decodeProcessNode(scene.bundle.process.body),
    [scene.bundle],
  );
  const states = new Map(
    runtime?.process.activations.map((a) => [a.node, a.state]),
  );
  const draw = (node: ProcessNode): React.ReactNode => {
    const children =
      node.kind === "seq" || node.kind === "par"
        ? node.children
        : node.kind === "repeat" || node.kind === "with-control"
          ? [node.body]
          : node.kind === "branch"
            ? [...node.cases.map((c) => c.body), node.otherwise]
            : [];
    const call =
      node.kind === "invoke"
        ? ` · ${node.device.kind === "ref" ? node.device.name : "设备引用"}.${node.behavior}`
        : "";
    return (
      <div
        key={node.id}
        style={{
          borderLeft: "2px solid #456",
          paddingLeft: 10,
          margin: "6px 0",
        }}
      >
        <code>
          {node.kind} · {node.id}
          {call}
        </code>
        <small style={{ marginLeft: 12 }}>
          {states.get(node.id) ?? "未激活"}
        </small>
        {children.length > 0 && (
          <div
            style={{
              display: node.kind === "par" ? "flex" : "block",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            {children.map(draw)}
          </div>
        )}
      </div>
    );
  };
  return (
    <details>
      <summary>工艺控制树 · 顺序／并行／循环</summary>
      <p>
        结构来自 DSL，状态来自当前运行；并行分支等待全部完成后再进入下一工步。
      </p>
      {draw(root)}
    </details>
  );
}

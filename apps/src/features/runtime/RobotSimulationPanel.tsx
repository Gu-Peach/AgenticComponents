import styles from "./RobotSimulationPanel.module.css";
import { useState, useRef, useSyncExternalStore } from "react";
import { useWorkspace } from "@/stores/workspace";
import { runtimeController } from "@/services/RuntimeController";
import { RobotStatePanel } from "./RobotStatePanel";
import type { RobotStep } from "@/contracts/robot-command";
export function RobotSimulationPanel() {
  const { project, selectedId, documentLocked } = useWorkspace();
  const s = useSyncExternalStore(
    runtimeController.subscribe,
    runtimeController.snapshot,
    runtimeController.snapshot,
  );
  const [q, setQ] = useState("0.2, 0, 0, 0, 0, 0"),
    [target, setTarget] = useState("0, 1, 0"),
    [frame, setFrame] = useState<"world" | "robot_base">("robot_base"),
    [material, setMaterial] = useState(""),
    [support, setSupport] = useState(""),
    [error, setError] = useState("");
  const serial = useRef(1);
  const active =
      s.instanceId === selectedId &&
      s.kind === "robot_experiment" &&
      runtimeController.isBusy(),
    busy = s.request?.status === "busy";
  const materials =
    project?.instances.filter(
      (i) =>
        i.visible &&
        project.definitions.some(
          (d) =>
            d.specId === i.specId &&
            d.deviceType === "workpiece" &&
            !d.template,
        ),
    ) ?? [];
  const supports =
    project?.instances.filter(
      (i) =>
        i.visible &&
        project.definitions.some(
          (d) =>
            d.specId === i.specId && d.deviceType === "conveyor" && !d.template,
        ),
    ) ?? [];
  const run = (fn: () => void | Promise<void>) => {
    setError("");
    Promise.resolve()
      .then(fn)
      .catch((e) => {
        setError(e.message);
        useWorkspace.getState().log(e.message, "error");
      });
  };
  const submit = (
    behaviorId: "move_joints" | "move_to_pose" | "execute_job",
    steps: RobotStep[],
  ) => {
    if (!selectedId) return;
    runtimeController.submitAction({
      requestId: serial.current++,
      instanceId: selectedId,
      behaviorId,
      steps,
    });
  };
  const prepare = (physical = false) =>
    run(async () => {
      const i = project?.instances.find((i) => i.instanceId === selectedId);
      if (project && i)
        await runtimeController.prepare(
          project,
          i,
          undefined,
          physical ? { materialId: material, supportId: support } : {},
        );
    });
  return (
    <div className={`behavior-card ${styles.panel}`}>
      <strong>机械臂运行实验</strong>
      <p className="muted-note">
        源GLB节点驱动；位置IK +
        关节PTP。参数为仿真配置，TCP为虚拟法兰；无全臂碰撞/避障。
      </p>
      <button disabled={documentLocked} onClick={() => prepare()}>
        准备机械臂预览
      </button>
      <label>
        关节目标 rad
        <input
          aria-label="机械臂关节目标"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      <button
        disabled={!active || busy}
        onClick={() =>
          run(() =>
            submit("move_joints", [
              { kind: "move_joints", q: q.split(",").map(Number) },
            ]),
          )
        }
      >
        执行关节运动
      </button>
      <label>
        TCP目标 m
        <input
          aria-label="机械臂TCP目标"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
      </label>
      <select
        aria-label="机械臂目标坐标系"
        value={frame}
        onChange={(e) => setFrame(e.target.value as typeof frame)}
      >
        <option value="robot_base">设备基座坐标</option>
        <option value="world">场景世界坐标</option>
      </select>
      <button
        disabled={!active || busy}
        onClick={() =>
          run(() => {
            const p = target.split(",").map(Number);
            if (p.length !== 3 || !p.every(Number.isFinite))
              throw new Error("目标需要三个有限坐标");
            submit("move_to_pose", [
              { kind: "move_to_pose", position: [p[0], p[1], p[2]], frame },
            ]);
          })
        }
      >
        执行TCP定位
      </button>
      <button
        disabled={!active || busy}
        onClick={() =>
          run(() =>
            submit("execute_job", [
              { kind: "move_joints", q: [0.2, 0.1, -0.1, 0, 0, 0] },
              { kind: "wait_time", seconds: 0.3 },
              { kind: "set_output", portId: "out1Tag", value: true },
              { kind: "move_joints", q: [0, 0, 0, 0, 0, 0] },
            ]),
          )
        }
      >
        执行空载任务
      </button>
      <div className="row">
        <button
          disabled={!active}
          onClick={() =>
            run(() => runtimeController.command("enableTag", false))
          }
        >
          减速保持
        </button>
        <button
          disabled={!active}
          onClick={() =>
            run(() => runtimeController.command("enableTag", true))
          }
        >
          恢复运动
        </button>
      </div>
      <div className="row">
        <button
          disabled={!active}
          onClick={() =>
            run(() => runtimeController.command("pause_pick", true))
          }
        >
          暂停抓取接单
        </button>
        <button
          disabled={!active}
          onClick={() =>
            run(() => runtimeController.command("pause_pick", false))
          }
        >
          恢复抓取接单
        </button>
        <button
          disabled={!active || busy}
          onClick={() => run(() => runtimeController.command("reset", true))}
        >
          复位机器人故障
        </button>
      </div>
      <details>
        <summary>固定约束物理抓放</summary>
        <p>
          先在场景摆放物料并填写质量。目标为所选传送带的静态支承面，运行不自动移动作者资产。仅工具、指定物料、目标支承和地面参与物理，其他场景设备不参与。
        </p>
        <select
          aria-label="机械臂运行物料"
          value={material}
          disabled={documentLocked}
          onChange={(e) => setMaterial(e.target.value)}
        >
          <option value="">选择物料</option>
          {materials.map((i) => (
            <option key={i.instanceId} value={i.instanceId}>
              {i.name}
            </option>
          ))}
        </select>
        <select
          aria-label="机械臂目标支承"
          value={support}
          disabled={documentLocked}
          onChange={(e) => setSupport(e.target.value)}
        >
          <option value="">选择目标传送带</option>
          {supports.map((i) => (
            <option key={i.instanceId} value={i.instanceId}>
              {i.name}
            </option>
          ))}
        </select>
        <button
          disabled={documentLocked || !material || !support}
          onClick={() => prepare(true)}
        >
          准备物理抓放
        </button>
        <button
          disabled={!active || busy || s.robot?.mode !== "fixed_grasp"}
          onClick={() =>
            run(() => runtimeController.pickAndPlace(serial.current++))
          }
        >
          执行抓放任务
        </button>
      </details>
      <div className="row">
        <button
          disabled={!runtimeController.isBusy()}
          onClick={() => runtimeController.stop()}
        >
          停止机械臂实验
        </button>
        <button
          disabled={s.status === "idle"}
          onClick={() => runtimeController.reset()}
        >
          重置机械臂实验
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <RobotStatePanel
        state={
          s.instanceId === selectedId
            ? s
            : { ...s, robot: undefined, request: null }
        }
      />
    </div>
  );
}

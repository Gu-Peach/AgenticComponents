# 通用场景运行装配

场景运行入口将场景包的控制树、真实资产、物理描述、条件与信号组成一个会话。装配不根据 S01 或设备实例名分支；S01 是当前完成三盘 36 件真实 Jolt 验收的候选仿真场景。

## 使用入口

在左侧下半区「场景」的「可导入场景」中展开 S01，点击「导入整场景」。新场景准备好后会替换画面中的旧场景和独立设备，工作台选中新场景并打开 PLC 面板。也可先点击「场景」标题栏的「清理场景」按钮。

```text
准备候选仿真 → ready → 运行 → 暂停 / 继续 / 停止 → 重置
```

准备时检查已导入包、模型和全部源文件的哈希。源文件改变后需要重新编译目录并重新导入，不能让旧包静默读取新契约。运行期间工程编辑被锁定；旧单设备运行入口也使用该锁，避免双重控制。

“暂停”冻结同一逻辑时钟；“停止”取消工艺、停止供料并等待实际停止回执。停止完成后重置会释放会话、恢复可视初态，下次准备生成新的 runId。若停止时机械臂仍持有物料，不能宣称交接完成或自动释放物料；保留约束与资源，最终进入 attention_required。目前尚无持料故障恢复操作面板。

场景包之外的示意资产不加入本会话的物理世界。视口提示会明确显示当前场景运行状态。

## 实现位置

| 文件 | 职责 |
| --- | --- |
| `src/contracts/scene-execution.ts` | 编译描述、有限实例、物理/可视绑定、准备诊断 |
| `src/domain/runtime/compileSceneRuntime.ts` | 解析控制树，核对独立目标、对象身份、网格所有权、环境与驱动组，生成统一物理描述 |
| `src/domain/runtime/SceneGeometryReader.ts` | 读取 GLB 实际 POSITION 数据及世界变换，构造各网格凸包点集 |
| `src/runtime/assembly/SceneRuntimeAssembler.ts` | 工厂装配、参数解析、条件提供者、环境服务、初始观测和独立终验 |
| `src/runtime/assembly/RuntimeFactoryRegistry.ts` | 按设备类型和契约版本选择实现，拒绝未知能力 |
| `src/services/prepareScenePackage.ts` | 校验包与源哈希，读取已导入模型及独立 task-spec |
| `src/services/SceneRuntimeController.ts` | 准备代次、取消/过期回滚、编辑锁、运行时钟和快照订阅 |
| `src/renderer/ScenePhysicsBridge.tsx` | 真实刚体位姿、机器人关节、有限预制体出现/消失和重置 |
| `src/features/runtime/SceneRunPanel.tsx` | 准备、运行、暂停、停止、重置和诊断 |
| `src/features/runtime/SceneProcessOutline.tsx` | 从 IR 展示顺序、并行、循环及实际激活状态 |

调度仍由 `runtime/scheduler/` 执行，信号由 `runtime/signals/` 管理。装配器没有另写一套工艺循环。

## 执行与证据

`SceneRuntimeProgram` 每个 1/60 秒逻辑步依次处理上一步观测、调度和资源授权、原子命令提交、全场物理步以及反馈发布。设备适配器不能自行推进或销毁世界。UI 每六个 tick 或状态变化时刷新，三维与 PLC 使用相同 runId/tick 的快照。

准备阶段最多执行 120 次无工艺命令的初始化物理步，确认第一盘的支承、约束和稳定性后才返回 ready。准备失败释放本次世界；取消或工程修订变化后的结果不能覆盖新会话。

当前注册的主动设备契约版本为 conveyor@1.2.0、robot_arm@1.0.0，支持场景实际使用的：

- 输送：`transport_to_position`、`transport_to_exit`、`release_material`、`stop_conveying`。
- 机械臂：`pick_and_place`、`move_to_pose`。
- 环境：单路有限载具供料、指定出口物料交接、空载具退出。

工艺点、输送成员、主体和数量来自场景数据。耦合组必须有唯一逻辑请求所有者；未知契约版本、行为或条件 key 不使用默认成功实现。

托盘 `relative_constraint` 模式建立真实固定约束；工具捕获成功时才转移为工具抓取约束。物料始终保持独立身份与刚体，后续托盘只在上一盘退出后准入。交接检查实际位置、速度、支承、持有关系与主体 ID，回执不能从 DSL 行号或计时器生成。

命名 entry/exit 是支承边界，执行目标会按载荷外廓留出内部停放空间。普通皮带只控制纵向运动，保留实际物料通道及支承高度；主线加工点仍跟踪作者声明的载具根参考点。

抓放内部采用分段抬升、离开取料区、转移和下降的路径。原有位置目标使用 CCD；候选搬运路径增加 DLS 保姿态求解，遵守关节速度、加速度、限位和迭代预算。该内部能力没有新增 DSL 行为，也没有改写作者点位。支承交接按实际凸包计算，避免旋转圆柱被外接长方体误判越界。

物理配置对复合载荷使用毫米级接触预测距离和细分物理子步。耦合输送支承只容许 10 微米的 GLB 浮点接缝容差；不能用此机制填平真实间隙。

## 信号与显示

端口类型、方向和命名空间来自契约。接受回执关联当前请求后撤销 execute/start_pick 触发；done/result_id 保持关联结果。出口放行许可来自真实 release 请求，part_ready、capacity_available 来自当前支承与在场物料。工具持有状态来自抓取约束。

没有实现绑定或没有命令编码声明的端口继续显示 unknown，不编造 commandTag 等枚举值。PLC 页展示的是行为接口与运行反馈；控制树表达工艺关系，不等同于已经生成或执行 PLC Structured Text 程序。

GLTFLoader 保留原始节点索引。编译器将规范化的关节名称映射回 GLB 索引，再由可视桥应用关节角，避免原始空格/方括号名称与规范名称不一致。托盘网格和物料网格分开驱动，防止父子变换叠加。运行位姿与未来批次不写回作者文件。

## 验收与边界

正式 S01 真实 Jolt 运行记录在 [008 运行证据](development-plans/evidence/008-s01-runtime.json)：三盘、36 件全部交付，类别与处理机械臂/出口符合独立 task-spec，空盘全部退出，最终资源为空。运行 44,874 个逻辑 tick，其中 31,263 个 tick 两臂 busy 同时为真；这来自实际执行状态。

`tests/assembly/` 覆盖整场运行、不同实例命名与隔离、单盘配置、未知能力与所有权拒绝、准备取消与工程过期、受控停止、复合碰撞、姿态求解及 GLB 可视关节与 FK 的一致性。

复现命令（在 apps 根目录）：

```powershell
node node_modules/vitest/vitest.mjs run
python -B -m unittest discover -s scripts/tests
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/next/dist/bin/next build
# 可选：在运行整场测试时导出独立证据
$env:AC_SCENE_REPORT = "$env:TEMP/ac-s01-runtime.json"
node node_modules/vitest/vitest.mjs run tests/assembly/s01-integration.test.ts
```

当前是候选仿真验收：使用场景声明的输送支承代理、GLB 凸包、虚拟夹具和模拟供料接触面，尚未覆盖机械臂全连杆碰撞规划与实体 PLC 执行。S02–S12 不因目录中已有文件而自动变为可执行；缺少对应配置或能力时准备阶段明确拒绝。本次实现没有修改 public 下的契约、DSL、节点或坐标。

## 浏览器验证记录

在本机生产构建中验证了导入、准备、运行、暂停、继续、停止完成和重置。暂停时 tick 保持不变，重置后 runId 改变；取消完成后可以重新准备。关节可视变换另有 GLB/FK 一致性测试。

[浏览器验证截图](development-plans/evidence/008-browser-proof.jpg)记录的是候选会话暂停在 tick 8079 的场景与 C2 实时端口，不代表浏览器已经跑完全部任务；整场 36 件结论来自独立的真实 Jolt 自动化验收记录。最终浏览器控制台未发现 error/warn。


## 009 条件与梯形图接入

当前准备默认使用统一条件表达式运行 profile。PLC 页默认显示按 DSL 生成的只读工步梯形图，设备接口视图保留为详情；两者共用本场景会话。使用方式及完整验收见[实时工步梯形图说明](scene-live-ladder.md)。

# 009 统一条件表达式与场景实时梯形图

本阶段承接 [008 场景装配](008-2026-11-06-generic-scene-runtime-assembly.md)。目标是从已有 DSL、设备行为契约和真实运行证据生成场景工步梯形图，解释何时启动、为什么等待、如何汇合及何时完成。

S01 范围的条件求值、决策轨迹和只读工步梯形图已按本计划接入。当前实现、使用方式和边界见[实时工步梯形图说明](../scene-live-ladder.md)。下文保留设计目标与 A 阶段记录。

## 1. 依据和实现边界

- Open-Industry 的 `docs/ladder.md`、`src/plc/ladder/ladder.ts` 描述 LD 模型到 ST 的转换，复用原执行引擎；`ladderWatch.ts` 读取运行变量，`ladderLeaf.tsx` 与 `LadderView.tsx` 推导显示导通状态。借鉴标准图元、运行值索引和可见行刷新，不把显示推导当作完整执行轨迹，也不复制商用厂商的格式或扩展。
- 当前 `SceneModulePanel.tsx` 展示设备端口，`SceneProcessOutline.tsx` 展示 IR 结构；它们尚未组成工步梯形图。
- `ConditionProviders.evaluate()` 返回 Boolean/unknown，`ProcessScheduler.checks()` 只保留未通过原因；细粒度条件、读到的样本和实际求值时刻尚未完整发布。
- `SceneRuntimeProgram` 已有单一固定逻辑时钟、请求关联、真实物理/观测帧；新显示不得另建调度器或推进物理。

主项目为 `E:/project/AgenticComponents/apps`；契约规范位于 `E:/project/AgenticComponents/test1/docs`，不是 test/docs；S01 路径为 `apps/public/scene/S01`。

## 2. 契约扩展与迁移

规范权威见 [统一条件表达式](../../../test1/docs/统一条件表达式.md)。使用独立版本 `ac-condition/0.1`，放在 `runtime_contract.condition_model`，保留现有条件 key、设备 version 和 contract_version，不修改 DSL 语法。

表达式只支持 all/any/not/compare/ref/literal/opaque。绑定区分设备信号、参数、执行配置、物理观测、资源授权和匹配请求回执。每个引用明确类型、单位、身份范围及有效性；描述文本不参与求值。

本轮 S01 实际调用的六种行为完成 22 项条件结构化；五份共享契约其他定义显式保留 opaque。不存在的细粒度提供者标记 pending_provider_binding，不使用新的布尔常量冒充实测结果。当前 execution_mode=declaration_only：结构检查通过后，仍由 008 原生提供者执行。

## 3. 目录与责任

| 位置 | 工作 | 本轮范围 |
| --- | --- | --- |
| `test1/docs/统一条件表达式.md` | 结构、类型、单位、三值逻辑、阶段和身份规则 | 落实 |
| `test1/docs/schema.md`、`设备契约.md`、`参数契约.md` | 统一引用新规范，说明与行为/参数/实例的关系 | 落实 |
| `public/scene/S01/contracts/*.json` | 增量声明；九实例复用五共享契约 | 落实 |
| `scripts/lib/condition_model.py` | 声明结构、端口/参数/载荷引用、类型/单位、防循环校验 | 落实 |
| `scripts/tests/test_condition_model.py` | 正向与拒绝样本、迁移覆盖测试 | 落实 |
| `src/contracts/condition-expression.ts` | 运行端表达式类型、绑定和编译描述 | 已接入 |
| `src/domain/runtime/compileConditions.ts` | self/参数/载荷/主体/资源解析与依赖检查 | 已接入 |
| `src/runtime/signals/ConditionEvaluator.ts` | 同一棵条件树的三值求值及证据收集 | 已接入 |
| `src/runtime/signals/ConditionTrace.ts` | 条件结果、读到的样本、短脉冲与状态转换事件 | 已接入 |
| `src/domain/runtime/compileSceneLadder.ts` | 控制树与条件树生成只读 LadderIR | 已接入 |
| `src/contracts/scene-ladder.ts` | 静态图元、来源、工步和连线定义 | 已接入 |
| `src/features/plc/ladder/` | 梯形图布局、工步展开、实时显示与证据详情 | 已接入 |

保留现有 SceneModulePanel 作为设备接口详情；默认视图逐步切换为场景工步梯形图。运行按钮继续共用 SceneRuntimeController，不因切换视图而重建会话。

## 4. 条件运行接入

1. 编译器校验扩展版本和所有引用。解析出的条件引用使用稳定 ID；数组表达式的叶子可以用条件 key + JSON Pointer 定位，运行时再附加 activationId。
2. 对每个细粒度 observation/provider 建立类型化描述与实际实现：主体支承、速度、放置、目标容量、交接回执、阶段约束等。先注册观测生产者，再允许条件读取。
3. 参数引用读取配置与实例覆盖；执行容差读取版本化 profile。输入不存在、类型不符或单位不同均拒绝，不默认为零。
4. 有效候选形成后原子申请资源，然后检查 authorization。不能把资源已授予放进自己申请资源之前的普通前置条件。
5. 前置只参与准入，持续条件按行为阶段检查。完成依赖同请求成功回执与实际结束证据，Done 是结果投影，不能反向成为成功原因。
6. 对现有 S01 原生条件与新表达式进行逐 tick 对照。差异必须定位到叶子、数据或规范，不能在有差异时静默切换。旧实现的不足应修正并单独说明。
7. 显式启用新运行 profile 后，以新解释器为唯一条件执行入口；展示使用同次求值结果，不能继续同时运行两套可能分歧的放行逻辑。opaque 可保留为可追溯的原生提供者块，但其内部不画猜测触点。

## 5. 梯形图生成语义

一次 invoke 对应一个逻辑行为工步，不按设备只画一个大框。相同设备的抓放和回位分别有自己的状态与请求。只显示本场景实际调用、条件、授权和停止依赖；完整设备端口保留在详情页。

| DSL / 契约 | 梯形图语义 |
| --- | --- |
| seq | 前驱完成后转移工步令牌，不能仅串接裸设备 Done |
| par | 各分支独立激活并竞争资源；不是 OR |
| join=all | 当前同轮各分支完成状态锁存后 AND 汇合 |
| branch | 保留 exclusive/ordered 规则，不能把互斥分支随意并联触发 |
| repeat | 循环控制块、当前迭代、集合/主体上下文；每轮生成新 activation/request |
| delay | 仿真时钟计时和到期状态，暂停冻结；计时到期不替代设备物理成功 |
| all/any/not | 条件串联、并联、逻辑取反 |
| compare | 类型化比较功能块 |
| opaque | 具名条件提供者块，显示已知结果及不可展开标记 |

工步启动链概念为：流程令牌有效 → 前置成立 → 获得资源/授权 → 尚未提交 → 提交一次请求。行为状态机持续被执行器推进，不能因前置触点在抓取后变假就把整个功能块停止扫描。

S01 出线令牌必须等待灰色分类循环和棕色分类循环全部完成，包括机械臂回位、出料、交接和停止；不是只等待两个机器人某次抓取 Done。循环中不得用旧托盘或旧物料的结果解锁下一轮。

## 6. 运行轨迹与显示

在调度实际求值处记录 `{runId, activationId, requestId, subjectId, nodeId, conditionKey, expressionPath, phase, evaluatedTick, inputSampleTick, value, quality, reason}`；并记录使用的具体绑定、阈值和读数。未求值、false、unknown、stale、disconnected 分开。

调度消费上一完整观测帧，之后才推进物理并发布新帧。因此“本次放行判定”与“当前端口读数”有明确时间差：图中不得把判定前输入与判定后反馈拼成同一条已执行导通链。显示决策时间和样本时间，并保留当前值查看入口。

实时视图只读；设备写入仍经唯一命令网关。绿线表示对应判定确实成立，灰色表示未激活/未求值，其他状态采用明确标识。串联链左侧未导通时，即使某个信号为 true，也应区分触点自身状态与整条路径状态。未知值的 NOT 仍然未知。

复用约 100ms 的 UI 发布频率，静态图不随数值重建。只更新可见梯级，缓存绑定索引，给数值列固定空间避免布局抖动。accepted/execute 等短脉冲写入有序事件环，不用 UI 定时器延长真实信号；事件环溢出显示丢失范围。

## 7. 实施阶段与验收门槛

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| A 声明规范与 S01 迁移 | 本轮规范、五份契约、Python 校验及派生包 | 悬空引用、类型/单位错误、未知版本、自触发与 Done 循环被拒绝；原有 S01 原生运行不回退 |
| B 编译与求值 | 绑定解析、细粒度生产者、三值求值与单一运行入口 | 逐 tick 与物理/请求证据对照；未实现提供者不能放行 |
| C 决策轨迹 | 求值路径、质量、身份、时间与事件日志 | 同请求、同主体、同轮关联；短脉冲可回看；旧样本不能误亮 |
| D 只读梯形图 | 工步梯级、并行/汇合/循环及设备详情 | S01 不写专用布局逻辑；节点改名/数量变化仍可生成 |
| E 整体验收 | 单盘与正式三盘 36 件、故障与 UI 验证 | 调度/物理结果不因开关梯形图改变；三维、端口、工步和判定可追溯 |

必测失败样本：unknown 取反、旧 Done、新请求复用旧结果、不同主体回执、缺资源、分支冲突、执行中前置变化、持续证据丢失、持料停止、出口阻塞、超时、重置后旧 run 数据、界面降频漏过接受脉冲。明确验证每个前置/授权/持续/完成阶段，避免只测试一个最终绿色状态。

## 8. 本轮文件保护与验证

本轮允许修改 S01 共享契约的条件扩展、S01 派生 bundle 和目录中 S01 的哈希。device 实例、关节轴/限位、GLB、scene.json、process.py、task-spec.json 及 S02–S12 保持原样。已导入的旧场景包需要重新导入。

使用 `python -B scripts/build-scene-catalog.py --scene S01` 定向重建，不重写其他场景包。执行 Python 契约与编译回归、已有 TypeScript 回归及 S01 36 件真实 Jolt 测试。原生运行证据与表达式执行验收分开记录，A 阶段通过不表示 B–E 已完成。

可执行 ST/LD 导出不属于本阶段默认交付；后续需要补齐扫描顺序、边沿存储、工步状态机、资源和数据类型映射，并通过独立等价性测试，不能把只读图的连线直接当硬件接线。


## 9. A 阶段实施记录

规范与 S01 的五份共享契约已更新，22 项条件结构化，其余 149 项保持 opaque；已接入声明验证器和 15 项新增 Python 检查。原有 condition key、设备能力版本、DSL 调用及运行放行逻辑保持不变。

验证结果：31 项 Python 测试、162 项 TypeScript 测试通过；S01 原生候选仿真完成三盘 36 件，44,874 tick，双臂 busy 重叠 31,263 tick。该结果证明声明扩展没有破坏 008 原生执行路径，不证明新表达式解释器已经实现。

已核对 334 个受保护文件，S01 作者节点、坐标、关节轴、GLB、DSL、任务目标与 S02–S12 未变；目录只有 S01 条目更新。编译后 48 份展开声明保留 condition_model。

证据：[迁移校验报告](evidence/009-condition-migration.json)、[原生运行兼容性回归](evidence/009-s01-legacy-native-runtime.json)。该记录对应 A 阶段；B–E 的当前结果见下一节。


## 10. B–E 阶段实施记录

已接入 compileConditions、ConditionEvaluator、SceneConditionBindings、ConditionTrace、compileSceneLadder 和只读 SVG 梯级视图。prepare 默认选择 expression 运行 profile；结构化条件由同一解释器执行并提供显示轨迹。原生条件只在 compare 模式参与审计，默认不作为第二套放行逻辑。

每条实际判定记录阶段、节点、运行/请求/主体/激活身份、求值 tick、输入帧 tick、叶子读数、单位、质量和来源。资源和请求阻塞来自调度器；停止物理条件即使尚无确认回执也会记录，但不能据此跳过请求停止确认。循环祖先校验防止下一轮尚未创建节点时误显示上一轮完成。

PLC 面板默认显示场景梯形图，保留设备接口详情；事件页读取实际信号变化，不延长脉冲。只更新可见梯级，静态图不按数值变化重建；图与接口页共享会话，切换不改变 runId/tick。

验证：197 项 TypeScript 测试、31 项 Python 测试、类型检查、lint 和生产构建通过。默认表达式模式完成三盘 36 件；对照模式比较 85,285 次、零差异；两者保持 44,874 tick 与 31,263 双臂重叠 tick。S01 作者输入哈希与 A 阶段记录一致，本次未修改 public 契约、DSL、节点、坐标或任务目标。

证据：[验证汇总](evidence/009-runtime-verification.json)、[条件对照](evidence/009-condition-comparison.json)、[默认表达式运行](evidence/009-expression-runtime.json)、[浏览器截图](evidence/009-live-ladder.jpg)。浏览器验证到第三盘并暂停；整批结论来自真实 Jolt 自动化验收。

可执行 ST/LD 导出和实体 PLC 接入仍不在本阶段内；其他场景/能力需要对应提供者及独立运行验收，不能仅以能生成图判断可执行。

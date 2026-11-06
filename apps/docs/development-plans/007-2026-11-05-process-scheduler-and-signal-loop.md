# 007 工艺调度层与真实信号闭环

日期：2026-11-05。项目根目录：`E:/project/AgenticComponents/apps`。

本方案承接[006场景开发方案](006-2026-11-05-scene-dsl-runtime-and-live-plc.md)，聚焦工艺调度和信号闭环。真实设备工艺节点由用户先补齐；本方案定义交付接口，使调度代码可以先用明确标为测试用的执行器验证，随后接入真实几何与物理反馈。测试桩通过不等于场景运行通过。

本次仅编写方案，不表示下述调度目录、状态机或实时信号功能已经实现。

## 1. 目标与边界

**工艺调度器独立放在`apps/src/runtime/scheduler/`，信号系统放在`apps/src/runtime/signals/`。** 二者通过类型化接口协作，不嵌入PLC界面，也不各自创建物理时钟。

目标链路：

```text
process.py + device契约 + 节点/物理标定
  → 编译层：ProcessIR → BoundProcess
  → 工艺调度器：激活工步、检查条件、仲裁资源、提交一次请求
  → 设备执行器：轨迹/驱动/夹持求解
  → 场景统一物理步
  → 物理观测与请求账本 → 真实信号快照
  → 调度器判断下一步 + PLC面板只读显示
```

编译器负责“程序是什么意思、绑定哪个设备”，调度器负责“当前执行到了哪里、何时允许推进”。设备执行器负责动作内部实现，物理引擎负责接触、约束、位姿等结果。工艺调度不是制造排程优化器，不负责自行改变订单、选机策略、路径或DSL规定的工艺。

本轮不新增wait_for；原来的等待被实现为节点生命周期中的内部状态。也不以ST编译器或硬件PLC通信为前提。PLC模块图是同一工艺与信号数据的投影，不成为第二个控制源。

## 2. 当前代码事实

| 当前文件 | 已有部分 | 本轮需要补齐 |
| --- | --- | --- |
| [场景构建脚本](../../scripts/build-scene-catalog.py)、[输入检查](../../scripts/lib/scene_binding_check.py) | 0.4受限AST、有限任务、行为/参数检查、哈希与场景bundle | 运行级强类型IR、可执行条件绑定、资源足迹、执行器就绪检查；当前executable固定false |
| [scene-package.ts](../../src/contracts/scene-package.ts) | 包、device、calls及资源引用 | process.body仍是宽泛record；不能直接把任意JSON交给运行器，需独立的判别联合校验 |
| [RuntimeKernel](../../src/runtime/engine/RuntimeKernel.ts)、[程序工厂](../../src/runtime/programs/RuntimeProgramFactory.ts) | 单机械臂或单输送程序 | 新增SceneRuntimeProgram接口，保留原实验兼容路径 |
| [SceneWorldStepper](../../src/runtime/engine/SceneWorldStepper.ts) | beforePhysics→一次物理step→afterPhysics；暂停、停止期限 | 尚未挂接控制树；异常时进入attention_required后不再步进，不能据此认为运动已停；需设计可继续停止与不可继续物理故障的区别 |
| [ConditionEvaluator](../../src/runtime/ConditionEvaluator.ts) | parameter/observation/authorization键值相等检查，缺值unknown | 样本质量、主体、请求、代次、有效期、条件树和解释链 |
| [RequestLedger](../../src/runtime/engine/RequestLedger.ts) | 单当前请求及seen去重集合 | 多实例账本、run隔离、提交与接受分离、取消后的实际停止、结果保留和有界去重 |
| [SignalRegistry](../../src/runtime/engine/SignalRegistry.ts) | 端口方向/数值检查、待提交输入、反馈发布与snapshot | 场景命名空间、writer授权、原子命令帧、质量与请求身份；当前pending Map会覆盖同名待提交值 |
| [runtime-signals.ts](../../src/contracts/runtime-signals.ts) | value/valid/tick/writer | 明确unknown/stale/invalid、runId、来源及事件序号 |
| [sceneModules](../../src/domain/runtime/sceneModules.ts)、[SceneModulePanel](../../src/features/plc/SceneModulePanel.tsx) | 由行为端口生成静态接口块，值为未知 | 条件/停止依赖端口、控制关系、快照订阅、信号变化与状态追溯 |

当前device中很多条件仍是`pending_provider`和说明文本，例如`C1/move_by_distance.completion`。声明signal_refs只说明依赖，不是可执行逻辑。工艺节点补齐也不会自动实现这些提供者；两项就绪状态必须分别检查。

## 3. Open-Industry参考依据及适用边界

本次参考的是本机Open-Industry工作树，提交`a882102c2b1e89ee04fb219b7dd0e1bddb3da632`。引用为实现思路，不复制整套PLC引擎，也不把其项目规则当作通用标准。

| 本地依据 | 读到的机制 | 在本项目采用的方式 |
| --- | --- | --- |
| [plcHost.ts](C:/Users/gt_20/.codex/worktrees/6d7b/Open-Industry/src/sim/plcHost.ts) `PlcHost.interleave` | 上一步设备反馈先锁存，再按仿真时间执行扫描，将输出交给即将进行的物理步；首个有效输入发布前不扫描 | 统一控制/物理步顺序，先初始化观测再开放生产；不从渲染帧读取条件 |
| [scanEngine.ts](C:/Users/gt_20/.codex/worktrees/6d7b/Open-Industry/src/plc/scanEngine.ts) `TaskScheduler.advance` | 扫描周期累加、周期任务/连续任务、追赶上限及超限统计 | 借鉴逻辑时钟与预算限制；它调度PLC扫描，不实现seq/par/repeat工步状态，不能直接当我们的ProcessScheduler |
| [simController.ts](C:/Users/gt_20/.codex/worktrees/6d7b/Open-Industry/src/plc/simController.ts)、[plcLink.ts](C:/Users/gt_20/.codex/worktrees/6d7b/Open-Industry/src/plc/link/plcLink.ts) `cycle` | 输入映像→执行一个扫描→输出映像 | 分离反馈快照、命令提交帧和UI观察表；一次控制求值读同一版本快照 |
| [DEVICE-IO.md](C:/Users/gt_20/.codex/worktrees/6d7b/Open-Industry/src/plc/DEVICE-IO.md)、[bindings.ts](C:/Users/gt_20/.codex/worktrees/6d7b/Open-Industry/src/plc/bindings.ts) | 明确设备与PLC方向、标签绑定和控制器输出所有权 | 从DeviceSpec生成唯一端口表和writer权限；不把设备输入等同硬件%I |
| [plc-typed-storage.md](C:/Users/gt_20/.codex/worktrees/6d7b/Open-Industry/docs/plc-typed-storage.md) | 编译后固定类型存储，外部写入仍检查类型/范围，保留独立参考实现 | 首版先用严格类型表与独立质量表；TypedArray可后续优化，不能用零初始化表示有效观测 |
| [document-and-run.md](C:/Users/gt_20/.codex/worktrees/6d7b/Open-Industry/docs/document-and-run.md) | 运行状态不写回作者文档 | 信号、位姿、工步状态只进入runtime store；不能触发工程保存/撤销或改写device JSON |

明确不照搬的地方：

- Open-Industry设备标签汇总中存在按顺序覆盖的规则；本项目多设备同名端口必须命名空间隔离，非法多writer直接报冲突。
- 单PLC实例的裸名别名不适用于我们的多设备`done`/`execute`；始终使用sceneInstanceId/instanceId/portId。
- Open-Industry扫描预算溢出有丢弃积压的实现；本项目不能丢弃已提交行为或物理步来赶进度。超预算应记录、降速或暂停诊断，保留控制与物理时间一致。
- 原实现里某些未连输入可保持零值；本项目契约门控要求未知不放行，必须保留独立质量语义。
- Open-Industry在worker内执行PLC是避免渲染影响控制的参考。首版可在当前固定步宿主接入，但控制代码不得依赖React/rAF频率；目标是可迁移worker且与无界面测试使用同一循环。

如后续需要实际迁入源码，另查许可证和归属，不把“参考”解释成可无条件复制实现。

## 4. 独立目录及依赖边界

建议新增以下目录；文件名是实现落点，不表示当前已经存在。

```text
apps/src/
  contracts/
    process-ir.ts                  # 源IR判别联合、表达式及source span
    bound-process.ts               # 已解析行为/条件/资源/载荷，不含闭包
    scheduler.ts                   # 激活、请求、候选、结果、生命周期类型
    scene-signals.ts               # SignalKey、定义、样本、质量与命令帧
    scene-snapshot.ts              # 同一run/tick的不可变场景快照
  domain/runtime/
    bindProcess.ts                 # 从device与IR生成BoundProcess
    bindConditions.ts              # 条件key到类型化提供者/表达式
    compileSignalLayout.ts         # 端口定义、命名空间、来源、writer权限
    compileResourceFootprints.ts   # 设备、工具、工位、物料与运动区足迹
  runtime/scheduler/
    index.ts                       # 对外入口，只导出稳定接口
    ProcessScheduler.ts            # 一次逻辑tick的工艺推进
    ActivationStore.ts             # 节点激活状态，迭代/请求身份
    nodeTransitions.ts             # seq/par/branch/repeat等纯状态转换
    ActionLifecycle.ts             # invoke准入、提交、接受、结束、取消
    ResourceArbiter.ts             # 原子授权、公平排队、阻塞解释
    RequestBook.ts                 # 多设备请求与去重/终态关联
    CollectionSnapshots.ts         # 有界集合冻结及有效性
    ProcessFinalizer.ts            # 循环交接及独立目标验收
    schedulerDiagnostics.ts        # 可定位的阻塞/超时/死锁诊断
  runtime/signals/
    SignalRegistry.ts              # 场景级类型表及值/质量，不与旧类并行存真值
    CommandBuffer.ts               # 当前tick的参数+触发原子提交
    SignalOwnership.ts             # 单writer授权及控制模式交接
    FeedbackPublisher.ts           # 设备反馈提交、质量/身份检查
    ObservationRegistry.ts         # 位姿/支承/交接等类型化观测
    ConditionProviders.ts          # 注册纯求值提供者；不eval说明文本
    SignalTrace.ts                 # 有序变化日志及断档标记
    compatibility.ts               # 旧SignalRegistry接口的薄适配
  runtime/engine/
    SceneRuntimeProgram.ts         # 组合scheduler、signals、drivers、world
    SceneWorldStepper.ts           # 唯一世界步进所有者，补采样/提交阶段
    RuntimeKernel.ts               # 统一程序接口及旧实验兼容
  runtime/adapters/scene/
    DeviceActionPort.ts            # 行为执行边界，不解释seq/par
    RobotActionAdapter.ts
    ConveyorActionAdapter.ts
    EnvironmentActionAdapter.ts    # 供料/换盘/接走的有限物理服务
  services/
    SceneRuntimeController.ts      # 准备/启动/暂停/停止/快照订阅
  features/plc/
    SceneModulePanel.tsx           # 只读snapshot
    ProcessGraph.tsx               # 工艺控制关系，与实际信号连线分开
    SignalInspector.tsx            # 值、质量、来源、请求、tick
```

依赖方向：contracts → 编译绑定/运行服务 → 调度与执行适配 → 场景组合宿主 → UI。scheduler只依赖契约类型、只读快照与抽象端口，禁止导入React、DOM、three、Jolt、Zustand或编辑器store。它不创建timer、不fetch、不自行初始化物理世界。

signals不依赖scheduler内部类；传入writer token和request identity即可。设备执行器可以依赖运动学和PhysicsPort，但不能调用调度器内部状态或直接改全局快照。UI只依赖只读SceneRuntimeSnapshot及命令控制器。

旧`runtime/engine/SignalRegistry.ts`逐步变为兼容入口，不能长期存在两份互不一致的真实信号表。旧RequestLedger可先包装到单设备RequestBook分区，随后统一去重规则。SceneWorldStepper不迁进scheduler目录：物理循环是宿主职责，不是工步算法。

## 5. 编译层交付给调度器的内容

运行器不得在每个tick重新解析Python。准备阶段完成：

1. 校验process/device/模型哈希、生产清单和task-spec。
2. 将宽泛JSON IR解码为受限判别联合；拒绝未知节点、超深树、循环超界和任意表达式。
3. 每个invoke锁定实例、契约版本、behaviorId、标量参数及payload适配器，禁止因同名行为而跨设备猜测。
4. 导入前置/持续/完成条件、有效性规则、请求协议、停止策略、超时、资源足迹和信号定义。
5. 校验所需provider与executor已注册且声明支持该行为/模式；用户节点完整但provider仍pending时，继续阻塞。
6. 生成只读BoundProcess及可解释诊断，区分syntaxValid、bindingValid、adapterReady、calibrationReady、executable。

一个拟议的BoundInvoke至少具有以下字段：

```text
nodeId / sourceSpan / instanceId / contractVersion / behaviorId
arguments / payloadBinding / resourceFootprint
preconditionRefs / sustainingRefs / completionEvidenceRefs
signalLayoutRef / protocolRef / stopPolicyRef / deadlines
```

BoundProcess只保存可序列化描述和注册表ID，不保存Python函数或任意JS闭包。进入worker时由固定注册表解析实现；不能从device JSON读取一段JS后执行。

构建脚本当前将executable固定false。后续应改为由能力报告计算，并在新bundle schema版本中引入受校验的ReadinessReport；不能只把Zod的literal(false)改成boolean然后相信文件里的true。运行启动仍重新检查资源哈希、实际provider和标定版本。

## 6. 工艺状态与控制语义

### 6.1 激活身份

静态nodeId只是程序位置。运行身份为`runId + nodeId + iterationPath + activationSequence`；设备请求再分配requestId及主体集合。每次循环必须生成新激活和新请求；不同场景实例的R1互不混用。

requestId投影到DINT时使用当前run内单调编号及明确的映射表。不能溢出后自动绕回旧号；达到上限应停止准入并报告。终态去重可压缩或分段清理，但未确认/仍可能重传的请求必须留存，旧run不得重新提交到新run。

### 6.2 invoke状态机

```text
pending → waiting_preconditions → waiting_resources → submitting
        → waiting_acceptance → running → verifying_completion
        → releasing → succeeded

任一非终态遇失败/取消 → stopping → failed / cancelled
停止证据缺失、停止超时或物理后端不可用 → attention_required
```

每个转换记录原因、tick、主体和引用证据。waiting是内部状态，不增加DSL语法。submitting只创建一次命令记录；传输重试复用同一请求，不再次执行物理动作。

前置条件必须先区分纯观测条件与授权条件：先用纯观测生成候选，再原子申请资源，在同一提交边界核验授权及快照版本。不能要求尚未申请的operation_authorized先为真，也不能占住所有设备等待另一个工步来产生前置条件。

结束要求：本次请求被接受、匹配的结果身份、必要物理/交接证据有效、持续条件未失效、清理完成。仅busy变False不能成功；error与done冲突时按协议故障处理，不能挑选成功字段。

### 6.3 复合节点

| 节点 | 运行规则 |
| --- | --- |
| seq | 维护当前子节点游标，前一子节点succeeded后后继最早下一逻辑tick激活 |
| par | 同时激活分支候选；授权可以使实际启动错开；join=all。失败后取消兄弟并等待停止，物理交接不回滚 |
| branch | 同快照判断exclusive/ordered；未知阻塞；选择后锁定，不在每tick重选 |
| repeat count | 计数提前验证，逐轮独立激活；0次也必须完成静态校验 |
| repeat collection | 先获得有效有限快照并冻结身份/顺序；未知不当空，实际空集合允许完成 |
| delay | 按整数逻辑tick计时；不作为设备完成证据 |
| with-control | 固定输入writer租约，进入确认后运行子树；成功/失败/取消均执行退出及实际停止确认 |
| fail | 产生有源位置的业务失败并走统一清理 |

循环节点还可绑定外部交接准入/收尾，例如S10换盘、S02批组接盘；条件只描述当前对象身份的物理事实，不藏入工序序列。ProcessFinalizer独立核对task-spec中的数量、工序、最终交接、空工具、停稳及无悬挂请求，控制树结束不直接等同整批成功。

### 6.4 资源与公平性

资源键至少覆盖设备执行槽、工具、物料、载具槽位/库位、交接区、运动区和共享输入writer。几何占用与执行授权分开保存；释放软件租约不会让托盘消失。

同一次申请的资源集原子授予或完全不授予，禁止持有一半资源再等另一半。候选采用固定优先级+等待年龄+稳定ID的确定性排序；策略写入运行配置并在回放中保持。超时诊断列出谁持有、谁等待、缺哪个证据。

抓取到退位期间的跨动作运动区占用不能因一个invoke结束就过早释放。由契约的占用/交接规则或明确的组合资源作用域保持；不能为简化实现把整条主线在整个batch期间永久锁住，也不能默认所有动作互不冲突。

## 7. 统一逻辑tick与首帧初始化

007首版规定：工艺扫描与物理外部步均为60Hz，一物理外部步对应一次工艺决策；不引入多个扫描周期。渲染帧率只影响展示，不改变逻辑顺序。后续多周期需求再增加明确的ScanClock，而不是调用Open-Industry TaskScheduler就自动获得工艺语义。

准备阶段：构建世界与所有provider→写入声明过的初始化命令→在不开放生产准入的条件下完成一次受控观测/必要物理初始化→形成有效S0。未完成初始化的输出仍unknown。与Open-Industry借鉴同一原则：不能从全零假输入开始生产判断；是否需要一物理步由本后端初始化规则决定，不机械复制其所有时序偏移。

每步顺序固定：

| 阶段 | 责任与数据 |
| --- | --- |
| A 读取 | 冻结上一物理步后的反馈、观测及请求结果Sk，全体候选只读这一快照 |
| B 归并 | 持续条件/故障优先；处理有效完成、取消和阶段超时；终态回执关联当前run/请求 |
| C 推进 | 调度器推进控制树、生成候选、原子仲裁；本轮新完成节点的后继留至下一tick |
| D 提交 | 校验参数、trigger和writer；同一次请求的载荷与触发作为命令帧原子提交 |
| E 求解 | 设备beforePhysics消费命令，生成控制/轨迹/约束意图；不推进世界 |
| F 物理 | 唯一宿主推进世界一次；允许后端内部子步，不允许设备再次调用step |
| G 观测 | 各设备afterPhysics采样实际结果，provider求值，账本归并并准备反馈 |
| H 发布 | 原子发布Sk+1及事件日志，UI读取；调度器不在H立即递归启动下一物理动作 |

控制帧与反馈帧各有序号，不能把G阶段部分设备已发布、部分尚未发布的混合状态交给调度器。准入快照失效时重算候选而非强行提交。

超时以逻辑tick计数。期限当tick内先检查有效证据，再判断未完成超时；持续条件失效优先于成功。暂停冻结逻辑时钟和期限，受控停止仍推进必要物理步直至确认；timeScale改变每秒执行步数，不改变单步dt或丢步。

## 8. 信号闭环的具体实现

### 8.1 定义与命名

端口定义唯一来源是实例解析后的DeviceSpec.signal_ports及明确的模型适配配置。格式统一：`sceneInstanceId/instanceId/portId`。runId附着在样本和请求上；重置更换runId并清空旧有效性。

设备input是调度/控制器向设备写入的命令；设备output是设备/观测向控制器发布的反馈。它们与PLC的VAR_INPUT/VAR_OUTPUT方向相反，也不等同硬件%I/%Q地址。空间interfaces不参与信号注册。

将端口映射、值、质量分离：

```text
SignalDefinition: key, direction, plcType, unit, range,
                  role, retention, allowedWriter, freshnessPolicy
SignalSample:    key, value|null, quality, sampledTick, changedTick,
                  runId, requestId?, activationId?, subjectId?, writer, source
SignalFrame:     runId, tick, revision, samples
```

quality至少为unknown/good/stale/invalid/disconnected。保持上次值并不意味着质量一直good；sampledTick表示来源实际更新，changedTick表示值发生变化。状态型信号需心跳/有效期，锁存结果按协议保持到确认或新请求，不能统一套用“一tick未变化就是过期”。

BOOL严格Boolean，INT/DINT检查整数范围，REAL拒绝NaN/Infinity且明确PLC投影精度；内部物理double与PLC REAL量化分层，不能无说明地用float误差阈值混判到位。单位转换必须显式适配，禁止speedTag与speedFpmTag同时写同一设定。

### 8.2 输入：单writer与原子命令

CommandBuffer在一个tick收集`writerToken + requestIdentity + parameters + trigger`。先校验完整写集合和权限，全部合法才提交；任意一项失败不能留下部分新参数和旧触发位。

控制模式至少区分process、manual和后续external_plc。一个物理控制入口同一时刻只有一个所有者；模式切换需停止或明确交接。PLC面板的监视不申请writer，手动调试命令也要走同一网关，不能直接改registry Map。

同一writer对参数的允许更新规则由契约声明，stopped_only参数不得运行时覆盖。不同writer写同一端口必须报冲突。急停/停止采用预定义优先级和授权撤销策略，不通过绕过所有权的第二个任意写入口实现。

### 8.3 接受、执行和结束握手

1. 调度器构造新请求，冻结对象与参数，提交payload和请求角色信号。
2. 执行器完成有效性和资源核验后接受，记录同一请求身份，再发布accepted/busy。
3. 网关按契约规则撤销或确认启动锁存，保持必要许可；不能在一个扫描周期内随意发完又清零。
4. 执行器按实际物理结果及内部阶段判断结束，写入RequestBook终态，再从该终态投影done/result_id/error/error_code。
5. 调度器读取匹配终态与所需交接证据，完成资源处置后才将invoke标成功。重复请求重发相同回执或拒绝重复，不再执行动作。

目前模板公共协议并未给所有设备提供独立accepted_id端口。需要关联接受身份时，由类型化ActionGateway的接受回执及冻结请求上下文完成；只有正式扩展契约后才增加物理端口，不能让UI偷偷画一个不存在的accepted_id。

### 8.4 结束判定不能循环依赖Done

现有某些completion signal_refs包含done/result_id。实现必须分成两层：

- **底层事实与执行器结果**：位姿/速度、编码器基准、支承、抓取约束、工件归属、交接记录、执行器阶段等；它们决定本次行为是否完成。
- **协议投影与调度确认**：账本终态产生done/result_id；调度器核对结果身份和事实证据。

禁止“completion provider等待done，而done又等待completion provider”。绑定器应检查provider依赖图并拒绝闭环。描述文本中的“完成”“已交接”不能作为实际算法，也不能直接读取expected_effects生成真值。

### 8.5 典型行为的证据来源

| 行为/信号 | 合法来源与结束要求 |
| --- | --- |
| move_by_distance | 请求接受时冻结编码器及载荷基准；表面行程、actual_speed、各载具真实位置/支承及容差共同确认。编码器到数而物料滑动不成功 |
| pick_and_place | 工具/工件真实接近与抓取约束、载荷校验、目标位姿、释放后目标支承及归属；命令中的target不是实际位置 |
| move_to_pose | FK所得TCP位置、姿态模式支持范围、速度和阈值；IK迭代结束不等于已实际到位 |
| transport_to_exit | 指定主体实际进入正确出口区域并有支承；part_ready不能由runTag或经过时长直接产生 |
| release_material | 同主体下游接收回执及归属变更；夹具释放/允许输出不等于下游已接收 |
| stop_conveying | 实际表面速度满足停稳容差，不能只看runTag=False |
| holding_material | 真实抓取约束/持有关系，不能只看gripper命令 |
| 工位库存/换盘 | 当前run、载具身份、实际槽位和交接事件；已知空与未知分开 |

没有现成信号能表达的事实进入ObservationRegistry，不凭空增加设备端口。若以后需要PLC端口投影，须在设备契约中明确其类型、来源、保持方式和实现者。

## 9. S01闭环的逐步例子

以`invoke(line_advance_005, C1, move_by_distance)`为例：

1. BoundProcess解析C1真实资产、pitch_m标定、target_distance参数口和运动区。
2. 在同一快照确认停稳、托盘/入口/出口状态、R1/R2实际退位和夹具状态，原子授予主线运动资源。
3. 写入目标距离及本次请求，输送执行器接受并保存基准；运行中发布真实actual_speed/encoderTag，托盘由接触物理推进。
4. 执行器按标定制动；只有实际停稳、冻结载具到达各自目标并保持支承才形成本次终态；账本投影done/result_id。
5. 调度器确认结果，在下一tick激活R1/R2两个分支；每个取放和退位仍走自身契约生命周期。
6. 每个分支完成真实出料交接，par全部完成后进入下一拍。最后一盘实际出线后ProcessFinalizer才允许整批成功。

这条链路没有独立wait_for节点，但每个阶段都有内部等待、有效性及超时。不能根据“代码执行到了下一行”点亮PLC中的Done。

## 10. UI动态显示与运行日志

SceneRuntimeController订阅同一宿主发布的不可变SceneRuntimeSnapshot，按较低频率向React发送展示更新；首版建议10Hz，与Open-Industry的观察表降频思路一致。控制与物理仍按60Hz运行，不从UI刷新次数计算逻辑时间。

snapshot包含设备信号、节点状态、请求、资源占用和阻塞诊断。控制依赖边来自IR，真实端口连接边来自SignalLayout；两种线分开，不能把seq自动画成Done→Execute硬连线。

变化高亮使用changedTick/event sequence。快速接受/结束事件用锁存或日志保留，不能因为10Hz展示没采到就丢失。日志有容量和序号；容量不足要标记丢失范围，完整验收轨迹使用独立导出通道，不能默默截断后仍宣称全过程可追溯。

同设备多个工步引用同一个真实信号块，显示不同activation并非创建第二个设备。unknown/stale/invalid和布尔False使用不同文本/样式。暂停显示冻结tick，重置清除旧run状态，退出后不继续显示旧Done为当前成功。

UI不能写反馈、随机数或依步骤计数制造运行值；不得为了展示效果构造不存在的“完成端口”。用户调试写入输入必须经过控制模式与writer校验。运行数据不进入工程的dirty/undo/autosave链路。

## 11. 与用户补齐工艺节点的交接约定

用户可以先补`public/scene/Sxx/device/*.json`。现有字段如node_binding、locations、calibrations继续作为入口；新增结构须先补类型与校验，不能只填未被编译器读取的任意JSON字段。

交接清单：

| 必要内容 | 调度/执行如何使用 |
| --- | --- |
| instance_id与模型哈希、唯一node_indices/路径 | 绑定当前GLB，重复或越界节点拒绝；一个运动节点一个所有者 |
| 设备/工艺位置坐标系及局部变换 | 将source/target/home/工位解析为实际世界位置；禁止把世界坐标重复乘变换 |
| 机器人link/关节轴/限位/rest pose/TCP/工具 | 供执行器求解与碰撞/夹持判断，调度器不直接操作GLB |
| 输送面/body/flow方向、观测区与节距/制动容差 | 供接触输送、到位与停止provider计算 |
| 托盘槽位、物料刚体及质量、初始装载 | 支承、容量、身份和生产数量核验 |
| 空间冲突区/交接容量/共享资源 | 编译ResourceFootprint与授权规则 |
| 可选模块与真实支持能力 | 没有的轴、分区驱动或加工功能不可由通用模板自动启用 |

标定文件只声明测得几何和参数，不含代码。条件provider、动作executor、环境服务是开发实现，不要求用户靠手填状态布尔值实现它们。节点补齐后先跑资产预检，能力和provider仍未完成时保留明确blocker。

先以S01约定的R1/R2/C1/C2/C3与载具/物料交付清单做贯通，再推广其余场景。用户更新节点哈希后，已有BoundProcess必须失效重编译，不能在运行中热替换标定。

## 12. 实施步骤、文件落点及验收

| 阶段 | 开发内容与主要文件 | 验收门槛 |
| --- | --- | --- |
| A 类型及绑定 | contracts/process-ir、bound-process、scene-signals；domain/runtime/bindProcess、bindConditions | 宽泛IR不能直接启动；条件/端口/执行器全部可追溯；未知provider与循环依赖拒绝 |
| B 调度核心 | runtime/scheduler内ActivationStore、nodeTransitions、ProcessScheduler、ActionLifecycle | seq/par/repeat/branch及失败/取消确定性通过；每个激活只提交一次；未知不放行 |
| C 资源和请求 | ResourceArbiter、RequestBook、CollectionSnapshots、ProcessFinalizer | 原子授权、无半锁等待、身份不串件、空集合/换盘/末端验收正确 |
| D 信号闭环 | runtime/signals内布局、命令帧、所有权、provider、反馈发布、日志 | 同tick原子帧；非法writer、错类型/单位、过期/旧run证据拒绝；Done无循环依赖 |
| E 宿主与适配 | SceneRuntimeProgram、RuntimeKernel、SceneWorldStepper、scene设备适配器 | 一个世界每tick一步；旧单设备实验不退化；正常/异常停止都有实际确认 |
| F S01真实贯通 | 接用户节点、工艺区及标定，机器人与输送/外部服务 | 三盘十二件身份与目标通过；双机器人真实时间重叠；主线取料互锁；PLC值与快照一致 |
| G 跨场景与UI | SceneRuntimeController、ProcessGraph、SignalInspector；推广设备适配 | 不同FPS轨迹一致；S02换组、S09共享机器人、S10换盘、S12两侧工序等专项通过 |

A—D可以在节点标定期间开发，使用明确的测试输入验证纯逻辑，且不解除任何真实场景运行阻塞。E—G需要真实适配与标定共同完成。worker迁移在E阶段按运行宿主能力落地，使用同一headless循环，不重写另一套调度算法。

### 必测反例

- 连续重复tick、重复命令、旧run/旧request的Done、accepted来自其它设备、done与error矛盾。
- 缺信号、质量过期、错单位、DINT越界、两个writer同写、命令参数只写一半。
- 前置观测为假/未知时不占锁；授权未获得时不提交；共享R1互斥而其它机器仍能前进。
- 空库存与未知库存、循环变量遮蔽、count=0、错误集合上限；循环实例不继承上一盘状态。
- par一支故障后的兄弟取消、动作超时但实际仍运动、物理后端故障、停止回执丢失。不能以dispose替代停稳。
- 带动而载荷打滑、无实际抓取约束、释放后掉落、错主体到出口、下游不接收。
- 相同输入在30/60/120FPS显示与不同timeScale下，按逻辑tick比较命令/结果轨迹一致；UI卡顿不能额外提交动作。
- 更新GLB或device后旧IR不能运行；保存工程不包含实时信号；两份S01实例之间同名端口不串线。

### 证据与完成判定

输出至少包含runId、源/模型/契约哈希、tick序列、节点激活、请求及终态、资源授予/释放、输入命令与反馈变化、物理观测引用、阶段超时和独立目标结果。测试驱动桩日志与真实Jolt日志分别标记。

计划使用现有`npm run typecheck`、`npm run lint`、`npm test`、Python场景编译测试及生产构建，并新增scheduler/signals专项测试目录。`tests/scheduler/`、`tests/signals/`、`tests/scene-runtime-integration.test.ts`为建议位置；不在本文宣称这些测试已运行。

007完成需同时满足：真实S01由DSL控制树推进；设备动作只提交一次并按实际证据完成；共享世界不重复step；PLC面板显示同一信号快照的动态值；失败/取消不会被错误显示为成功。只有纯调度单元测试通过，或模块图能够亮灯，均不算完成。

## 13. 本次交付

本次完成当前引擎/设备契约与本地Open-Industry扫描链路核对，明确独立scheduler/signals目录、状态机、tick时序、条件provider、命令/反馈协议及节点标定交接要求。仅新增007文档并更新开发方案索引，未修改运行代码，也未替用户填写设备工艺节点。

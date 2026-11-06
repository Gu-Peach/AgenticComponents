# 008 通用场景运行装配器与 S01 整场闭环

日期：2026-11-06。项目根目录：`E:/project/AgenticComponents/apps`。

本计划承接[006 场景开发方案](006-2026-11-05-scene-dsl-runtime-and-live-plc.md)与[007 工艺调度和信号闭环](007-2026-11-05-process-scheduler-and-signal-loop.md)。目标是将已经实现的模块接成可执行会话，S01作为首个真实场景验收用例。本文保留本阶段的设计与验收目标。当前实现、使用入口和能力边界见[通用场景运行装配](../scene-runtime-assembly.md)。

## 1. 核心决策：装配器通用，S01只是首个验收场景

装配器面向统一DSL、设备契约和场景包，不能只为S01工作。通用装配流程中禁止按scene_id分支实现工艺，不硬编码R1/C1等实例名、三盘36件、颜色分类、工位坐标或抓取顺序。

三层职责：

| 层次 | 职责 | 复用范围 |
| --- | --- | --- |
| 通用运行装配器 | 校验包与版本、解析符号/坐标/对象、注册能力、创建物理世界、绑定工艺及启动会话 | 所有采用统一规范的场景 |
| 设备/环境适配器 | 机械臂、输送、耦合驱动、供料、交接等行为实现 | 按设备类型、行为能力和模型配置复用 |
| 场景配置与DSL | 实例节点、点位、驱动组、初始装载、有限订单及控制关系 | 每个场景不同，由作者数据表达 |

例如，S01的主线成员来自scene.drive_groups，目标来自scene.sorting_station或device.locations；编译器据此配置通用位置输送适配器。运行代码不得出现`if scene_id == "S01"`来启动两条特定输送线。

S02若使用的设备能力已经支持，只需提供有效配置与DSL即可复用装配器。若缺少能力，应新增或扩展相应设备/环境工厂并做契约检查，不另写一个S02专用调度器。通用不等于首版无条件支持所有设备；不支持的能力必须产生可定位的阻塞。

## 2. 当前已有模块与真正缺口

以下为本次核对的已有代码入口，不将单模块测试结果视为整场运行结果。

| 已有模块 | 可复用内容 | 装配阶段还需完成 |
| --- | --- | --- |
| [场景构建脚本](../../scripts/build-scene-catalog.py)、[设备展开](../../scripts/lib/scene_devices.py) | 0.4受限DSL、共享contracts解析、节点/静止位姿生成、预制体展开与输入哈希 | 输出运行所需的全部结构化依赖，补齐readiness边界，保持作者数据与派生数据分离 |
| [bindProcess](../../src/domain/runtime/bindProcess.ts)、[bindDeviceBehavior](../../src/domain/runtime/bindDeviceBehavior.ts) | 控制树、行为版本、参数/条件、资源与执行模式绑定 | 自动从场景能力表建立完整绑定，不再由测试逐个手工拼装 |
| [ProcessScheduler](../../src/runtime/scheduler/ProcessScheduler.ts)及signals目录 | 工步生命周期、请求/资源仲裁、条件、命令与反馈帧 | 得到真实设备执行器、条件提供者、对象身份和环境服务 |
| [SceneRuntimeProgram](../../src/runtime/engine/SceneRuntimeProgram.ts) | 调度、请求提交、一次物理步及反馈发布的组合宿主 | 接收通用工厂生成的全场drivers/world，不额外创建第二个时钟 |
| [compileSceneRobot](../../src/domain/runtime/compileSceneRobot.ts)、[RobotSceneAdapter](../../src/runtime/adapters/scene/RobotSceneAdapter.ts) | 米制场景运动学、显式无限位、复用轨迹/抓放执行器 | 为每次物料和目标构造正确RobotStep、支承与工具引用，验证碰撞与实际抓放 |
| [PositionTransportAdapter](../../src/runtime/adapters/scene/PositionTransportAdapter.ts)、[bindPositionTransport](../../src/domain/runtime/bindPositionTransport.ts) | 位置目标输送、统一控制组成员、实际位置/速度/支承反馈及请求握手 | 从场景自动生成目标表、主体参考点、资源及下游交接回调 |
| [compileTransportTargets](../../src/domain/runtime/compileTransportTargets.ts)、[mergeCoupledConveyors](../../src/domain/runtime/mergeCoupledConveyors.ts) | 目标坐标解析，严格校验后的连续共面联合支承代理 | 由驱动组声明选择使用；几何不兼容时拒绝合并，不任意补平间隙 |
| [JoltPhysicsBackend](../../src/runtime/physics/jolt/JoltPhysicsBackend.ts) | 多输送面、载具支承、寻址刚体、预分配实例启用/移除 | 从整个场景生成可靠的body/surface/tool配置，不能用未验证代理冒充真实几何 |
| [FiniteSceneEnvironment](../../src/runtime/services/FiniteSceneEnvironment.ts) | 有限供盘、支承确认、物料交接、空盘移除与回执 | 接入每轮准入、出料行为和独立验收，按场景声明驱动而非测试直接调用 |
| [SceneRuntimeController](../../src/services/SceneRuntimeController.ts) | attach/start/step/pause/stop/detach及快照订阅 | 当前没有自动prepare入口；尚未从选中的场景包创建完整会话并接运行按钮 |

因此本阶段主要是装配、生命周期和应用接入。DSL与契约以当前版本为基线；发现具体接口缺口时局部修正，不重写已经清楚表达的工艺。

## 3. 建议落地目录

装配逻辑独立放在`apps/src/runtime/assembly/`，避免继续扩大SceneRuntimeController或在UI中注册具体设备。

```text
apps/src/
  contracts/
    scene-execution.ts                 # CompiledSceneRuntime、ReadinessReport、资源与可视绑定描述
  domain/runtime/
    compileSceneRuntime.ts             # 通用场景编译入口：只生成运行描述和诊断
    resolveSceneFrames.ts              # 场景/设备/物料/工具坐标与参考点
    compileSceneBodies.ts              # 刚体、输送面、工具、碰撞代理与资源区
    compileSceneInventory.ts           # 有限实例、预制体、身份和初始归属
  runtime/assembly/
    index.ts                          # 稳定公共入口
    SceneRuntimeAssembler.ts           # 分阶段装配与失败回滚
    RuntimeFactoryRegistry.ts          # 按能力/契约版本选择工厂，不按场景ID
    createScenePhysics.ts              # 创建唯一Jolt世界及实例物理句柄
    registerSceneAdapters.ts           # 机械臂/输送/分组/环境服务工厂编排
    registerSceneConditions.ts         # 条件key到实际提供者的注册
    createSceneActionResolvers.ts      # 类型化行为参数/载荷到具体执行输入
    createSceneFinalizer.ts            # 独立目标监测、身份和交接回执
    ScenePreparationScope.ts           # 构建中拥有的资源与逆序清理
  services/
    SceneRuntimeController.ts          # 新增prepare，统一运行/停止/重置及订阅
  renderer/
    ScenePhysicsBridge.tsx             # 刚体快照到模型实例变换
    SceneRobotBridge.tsx               # 机器人关节快照到对应关节节点
    ScenePrefabInstances.tsx           # 有限物料/托盘可视实例的启用与移除
  features/runtime/
    SceneRunPanel.tsx                  # 场景准入、准备、启动和阻塞详情
  tests/assembly/
    scene-compile.test.ts
    scene-preparation.test.ts
    adapter-selection.test.ts
    genericity.test.ts
    s01-integration.test.ts
  e2e/
    scene-run.spec.ts
```

新目录名称为计划落点。domain/runtime不能创建物理世界或操作编辑器store；assembly依赖抽象工厂和现有运行接口；renderer只应用快照，不执行工艺、不驱动仿真时间。已有scheduler/signals继续负责自己的状态，不在assembly复制一套状态机。

## 4. 通用输入与输出

### 4.1 输入

准备入口读取场景实例锁定的包、模型资源、process IR、合并后的device/contracts、有限任务、环境声明和task-spec。校验模型与输入源哈希；包中保留同一输入的唯一权威来源。

当前S01的sorting_station可作为已有位置声明形式，编译时归一化到通用ProcessPoint表。目标ID由声明的id生成，例如`scene.sorting`；装配算法不能写死此名称或坐标。后续多个加工点通过统一表扩展，不为每种场景新增一个特例入口。

构建产物须包含装配所需的drive_groups、environment、execution、独立验收目标或其已验证引用。不能只保留calls摘要而丢掉工艺控制树，也不能读取旧batch/bindings作为隐含回退。

### 4.2 编译输出

CompiledSceneRuntime至少包含：

- 场景实例ID、包版本、全部资源哈希与准备代次。
- 经过类型检查的ProcessIR、有限生产清单、点位/对象/DINT登记。
- 每个设备的参数、行为实现需求、节点/关节/工具/物理绑定和信号布局。
- 刚体、接触面、工具、碰撞代理、可视所有权及预制体生成策略。
- 耦合驱动组、资源足迹、条件依赖、外部交接和独立验收描述。
- ReadinessReport：语法、契约绑定、实现能力、几何/物理、初始化观测各自的通过与阻塞项。

此输出是可序列化描述，不携带从JSON执行的函数。运行工厂注册表由受信任的TypeScript代码提供实现，不能eval契约文本。

## 5. compileSceneRuntime的处理步骤

1. **输入一致性检查**：校验hash、版本、引用与唯一身份；已导入旧包与最新作者文件不同应明确提示重导入/重编译，不静默替换。
2. **解析控制树**：保留seq/par/branch/repeat/invoke等关系、步骤ID与源码位置；不从设备清单推断工艺顺序。
3. **展开有限对象**：由production及预制体生成完整身份表。已有GLB对象采用adopt_existing，未来对象采用clone_on_admission；数量来自任务，不写死3或36。
4. **归一化坐标与目标**：处理节点导入比例、参考点、局部姿态、设备位置及随载具移动的槽位。
5. **建立物理/可视描述**：将设备支承与载荷分开，检查碰撞代理、质量、摩擦、可选能力和所有权。
6. **能力匹配**：依据设备类型、行为ID、契约版本、运行模式和模型profile匹配工厂；所有DSL调用及自动停止/交接依赖均要覆盖。
7. **绑定条件与协议**：解析前置/持续/结束条件、资源、请求/反馈及释放义务；未实现的provider应列出具体key，不只给出一个“pending”。
8. **返回准备计划或阻塞报告**：编译无物理副作用；不能通过把executable改为true跳过检查。

校验失败要附带sceneInstanceId、deviceId、behaviorId/nodeId、来源文件和缺失字段。遇到未支持的加工设备、环线或特殊轴，保留可浏览状态并报告所需工厂，不能落到通用空实现。

## 6. 坐标、TCP与主体参考点

需要显式区分三类目标：场景工艺位置、载荷刚体参考位置、机械臂TCP目标。不能把同一XYZ无条件赋给它们。

- 场景点声明frame、单位、reference和support_device。当前S01的加工点reference为carrier_origin，执行时追踪托盘根参考点，结合刚体中心偏移判断到位。
- 物料抓取点由当前实际物料位姿、抓取几何与工具配置得到，不永久使用GLB初始坐标。槽位跟随载具实际姿态变化。
- 放料位置要考虑物料外廓、支承面及工具偏移。entry/exit可能表示区域边界，必须明确根、中心或前沿的到达语义，不能把物料中心放到支承边缘后直接释放。
- 机器人位置IK只承诺当前支持的模式。显式null关节限位按无限位解释，缺少限位字段仍属于未声明；速度、加速度与实际停稳检查不因此取消。
- GLB的导入比例只转换一次。当前生成的world_position/world_rotation及关节rest translation已有米制含义，不能再乘一次0.01。
- 已有坐标不在装配阶段被“修正”到另一个容易通过的点。无法到达、碰撞或支承不足应返回证据与诊断。

需要提供无副作用的FK/IK预检，并明确其只证明位置求解结果；它不能替代实际轨迹、夹持、碰撞和交接验证。

## 7. 创建统一物理世界

createScenePhysics依据编译描述一次性创建世界与必要body/surface/tool句柄，并返回映射表。装配器是世界生命周期的唯一所有者，设备只执行beforePhysics/afterPhysics，不自行step或dispose世界。

物理对象至少覆盖：输送接触面、托盘、独立物料、工具，以及会影响运行的设备/环境碰撞体。渲染网格不能直接当作已验证碰撞代理；模型要求convex/compound而后端只提供box时，应明确阻塞或使用有记录、经过验证的仿真代理，不静默替换。

初始已有载具/物料采用GLB世界位姿建立物理对象。未来批次可预分配但未加入物理世界；仅在供料准入后启用，不提前占用入口，也不提前显示在视口。

托盘根子树可能包含物料。托盘刚体只拥有其木结构/垫板等声明网格，物料拥有各自网格及body。可视分离时保留世界位姿，禁止托盘父变换和物料物理位姿同时驱动同一物料。

对耦合输送段，只有通过共面、连续性、流向与接触参数检查后，才可以使用已有联合支承代理消除内部碰撞接缝。真实间隙、不同高度或不同驱动策略不能被补平；不符合条件时选择可支持的分段接触实现或拒绝准备。

同一模板可以共享几何/材质资源，但每个运行物体必须有独立逻辑身份、物理状态和信号命名空间。停止、销毁与工程文档分离，运行位姿和动态物料不写回作者文件。

## 8. 工厂注册与行为载荷解析

RuntimeFactoryRegistry按以下信息匹配实现：

```text
device_type + contract/profile version + requested behaviors + configured capabilities
```

建议工厂输入包括compiledDevice、world handles、signal layout、point/inventory registry、environment services；输出包括drivers、ActionBindings、ConditionProviders、ObservationDefinitions、resource requirements和清理句柄。由装配器统一检查重复注册、缺失依赖和writer冲突。

工厂种类至少包含robot、conveyor、coupled conveyor、passive load、environment。一组耦合设备只能创建一个运动所有者。由drive_groups与实际DSL调用推导唯一逻辑主控，若存在多个冲突主控则拒绝，不默认选第一个成员。

S01当前以C2的transport_to_position请求统一控制主线两段。这个结果应由其配置和调用推导，换一组成员名仍能工作。C1可以显示从属驱动的真实I/O，但不能伪造第二次独立工艺请求。

createSceneActionResolvers要解决：

- 机械臂payload的material/source/target如何映射为本次实际物料body、目标支承面和RobotStep。
- 输送的subject_id如何映射为物料或载具，target如何解析命名点与参考偏移；行程和制动在执行器内部求解。
- transport_to_exit采用该设备明确的出口目标，release_material调用真实交接服务，stop_conveying检查实际停止。
- 连续与有限行为、可选模块、无限位策略和支持模式必须与注册实现一致。

所有执行器必须覆盖本场景用到的行为，以及失败/取消的停止路径。不能只注册主动作却遗漏release、stop或外部接收。工艺分支、循环和选机仍由DSL决定，不能藏进resolver。

## 9. 条件提供者和信号注册

registerSceneConditions从契约key、类型化观测和场景资源建立实际求值，不执行自然语言description。定义完整不等于provider已实现。

例如工具为空来自实际持有/抓取约束；托盘停稳来自当前主体速度和支承；物料交接来自环境服务同run/主体的真实回执。现有碰撞/运动区条件须绑定到实际区域和资源，禁止统一返回true。

资源授权与纯观测前置分开：先形成有效候选，再原子授予资源，随后校验授权并提交。不能先占着设备等另一个需要该设备的动作产生前置条件。

SignalRegistry从实际契约端口生成唯一命名空间。输入由网关提交，输出由对应设备/观测提供者发布；组驱动的逻辑端口别名映射到同一个物理控制所有者，不能产生两个writer。参数与触发原子提交，接受回执关联本次请求后撤销触发；done/result_id按约定保持。

完成判断先由实际位置、支承、约束和交接证据形成请求终态，再投影协议反馈。不能让completion等待done，而done又等待completion。未知、过期、错主体或旧run信号均不能放行。

未使用端口可以保持unknown，不要求把设备全部行为都执行一遍。PLC模块取本流程及停止/故障/条件依赖涉及的端口，并保留可追溯来源。

## 10. 环境服务与独立验收

将scene.environment绑定到通用环境工厂：有限供料、载具供盘、接收移除和换盘。对象与数量来自production；服务不能私自增减任务。

供盘顺序：入口空间和上轮交接确认→启用本轮载具及独立物料body→物理步确认支承/稳定→发布准入证据。启用对象不等于完成供料，不得跳过真实接触观察。

移除顺序：当前主体真实到达指定接收位置并停稳、无工具持有、接收条件成立→记录同主体交接→移出物理与可视世界。空盘移除还要核对该盘全部预期物料交付，不只看托盘当前没有接触物料。

ProcessFinalizer使用独立task-spec核对身份、数量、类别路由、工序次数、空盘出线、工具为空、驱动停稳和资源清理。不得从“DSL执行到最后一行”生成批次完成。

小规模验证使用明确标记的独立测试任务和对应目标，不改正式三盘36件目标来获得绿色结果。

## 11. prepare事务与控制器入口

目标应用入口为：

```text
选择任意场景实例 → prepare → 检查通过 → start
                       ↓
           调度、物理、信号和渲染共同运行
```

SceneRuntimeController新增prepare(sceneInstanceId)，其内部调用通用装配器，不含S01专用逻辑：

1. 冻结工程修订、场景包版本和源哈希，创建准备代次/取消令牌。
2. 编译运行描述并收集阻塞；硬阻塞存在则不启动生产。
3. 通过ScenePreparationScope创建物理世界、对象、执行器、provider和注册表。
4. 完成无生产命令的初始观测；必要时执行有界初始化物理步以确认支承。未取得证据的样本仍unknown。
5. 构造BoundProcess和SceneRuntimeProgram，生成ready快照。
6. 再次确认工程/包版本和准备代次仍一致，原子挂接到控制器；失效的准备结果不能覆盖新工程。

准备失败按逆序释放本次分配的对象和监听器，保留当前工程及已有会话。编译失败不能留下半个运行世界或一半已锁定的设备。用户在prepare期间切换场景或修改文档，要取消旧准备并清理其资源。

start只接受ready会话；pause冻结逻辑时钟；stop先停止准入并执行受控停止，实际停止未确认时显示attention_required，不能通过dispose伪装停止。reset在合法状态下重建初态及新的runId，旧请求/信号不能延续到下一次运行。

一个场景实例不能同时由旧单设备预览和场景会话控制。场景运行期间对应文档编辑需要锁定或明确停止重编译，不允许改动正在执行的参数/节点映射后继续沿用旧绑定。

## 12. 可执行状态与候选标定

当前包schema中的executable固定false，不是已经完成的能力评估。应新增有版本的ReadinessReport，由准备阶段检查结果生成，不能简单放宽为boolean并信任文件里的true。

至少分开显示：

- 可浏览：GLB及目录可加载。
- 可编译：语法、身份、引用和参数一致。
- 可准备：所需实现与物理描述齐全，且没有不可接受的标定缺口。
- ready：世界、provider和初始观测准备成功。
- 已验证：对应测试任务实际运行并通过独立目标。

candidate点位允许进入明确的仿真校验流程，但不能自动改成“标定通过”。当前用户同意的无限位、虚拟夹具和候选加工点作为显式仿真配置使用，仍需验证其真实轨迹/支承/交接结果。通过一次位置IK预检不能自动解除碰撞或接触阻塞。

## 13. 三维与PLC界面接入

三维与PLC必须订阅同一SceneRuntimeSnapshot，使用相同runId/tick解释状态。

- ScenePhysicsBridge把body实际位姿应用到相应可视实例；按编译好的body-local映射处理模型原点偏移，不能直接把物理中心赋给GLB根。
- SceneRobotBridge应用对应实例的关节状态和rest旋转，不修改共享模型缓存或另一份场景实例。
- 预制体可视实例随真实admission/removal事件出现和消失，不提前生成可见的P02/P03，不以动画计数代替环境回执。
- PLC面板展示真实端口值、质量、采样tick、请求及当前激活节点。控制关系边来自IR，信号边来自真实映射，不能把seq直接伪装为硬件Done→Execute接线。
- 当运行尚未准备或反馈失效时显示未知/阻塞；不以定时器、随机数或源码行号点亮反馈。
- UI可以降频刷新，但不驱动控制时钟；接受/完成等事件保存在运行日志中，不因展示降频而丢失。

运行按钮要提供明确的准备与失败状态，并能定位到具体设备、行为或点位。现有ST文本页继续保留其真实支持边界，不因模块图运行而宣称ST已执行。

## 14. 实施顺序与阶段门槛

| 阶段 | 交付 | 阶段验收 |
| --- | --- | --- |
| A 通用编译入口 | CompiledSceneRuntime、符号/点位/对象/能力表及ReadinessReport | 同一编译入口处理不同场景包；未知能力、缺引用和过期哈希给出明确错误 |
| B 世界与实例装配 | createScenePhysics、资源事务、物理/可视所有权 | 一个世界、一个物理步所有者；预制体未准入时不出现；失败无资源残留 |
| C 行为与证据接线 | 工厂注册、ActionResolvers、ConditionProviders、环境与目标监测 | DSL每个调用和自动停止/交接义务都有实现；没有“默认通过”的provider |
| D 应用入口 | controller.prepare、运行按钮、统一快照和渲染桥 | 从资产库导入后可经过prepare启动；暂停/停止/重置正确，三维与PLC信号一致 |
| E S01闭环 | 先小规模测试，再正式三盘36件 | 实际到位、双臂处理、分类出料、空盘移出与最终目标全部有物理/回执证据 |
| F 通用性回归 | 第二配置或S02接入，实例重命名和任务数量变更测试 | 不改装配器与已支持设备代码即可适应配置变化；缺新能力时只扩展对应工厂 |

S01的专用测试数据可以保存在tests/fixtures或对应场景包，不进入通用装配算法。阶段E的物理问题应定位到模型、适配器或工艺配置，不以scene_id特判绕过。

## 15. 必须通过的测试

### 通用性

- 把设备ID换成另一组合法名称，保持引用关系，装配仍成立。
- 同一场景包实例化两次，body、信号、请求和资源完全隔离。
- 改变有限任务数量后，实例化与最终验收按输入变化，不仍固定三盘36件。
- 更换加工点坐标或驱动组成员后使用新配置，旧BoundProcess失效。
- 提供使用已支持能力的第二个场景配置，不增加新的场景分支即可准备运行；不支持的能力只产生能力诊断。

### 装配与生命周期

- 模型缺失/哈希变化、节点歧义、重复body所有权、错误参考系、缺provider、可选模块未启用均拒绝。
- prepare过程中取消或工程版本变化，不留下物理世界、监听器或编辑锁。
- 单tick全场只推进一次，多个适配器不会重复step或提前dispose。
- 旧单设备机器人/输送测试保持通过，非法双控制源不能同时驱动同一对象。

### S01物理闭环

- 第一盘采用GLB中已有载具与十二件物料；后两盘按准入创建独立对象。
- 主线根据命名点位输送，实际托盘参考点到位并停稳才允许取料；两段驱动同步且故障联停。
- R1/R2在满足资源区约束时实际并行，各处理正确主体和目标。记录真实时间重叠，不以par节点存在作为证明。
- 物料由真实抓取约束转移并在目标支承上释放；出料和移除按同主体回执确认。
- 非空托盘、错主体、未到出口或仍被工具持有的对象不能被移除。
- 正式三盘36件完整覆盖，零丢失、零重复，工具为空、驱动停稳、请求和资源清理完成。

### 故障与显示

- 打滑、掉落、抓取失败、出口阻塞、旧Done、错误主体回执和停止超时不能变成成功。
- UI信号值与对应tick的运行快照一致；暂停冻结、重置清空旧run、掉线/过期显示正确。
- 帧率变化不改变逻辑tick上的请求与结果顺序；日志保留未展示到的边沿和丢失范围说明。

## 16. 交付证据与完成标准

输出可复现报告：输入/模型/契约哈希、编译与准备诊断、资源/驱动注册表、运行ID、实际物理步数、请求及信号轨迹、每件物料交接/工序记录、停止结果和独立目标判定。

先通过小规模测试的报告必须标明其任务范围，不能作为正式三盘目标的替代。真实Jolt运行报告、运动学预检和测试桩日志分开标记。

使用现有类型检查、lint、单元测试、Python编译测试及生产构建，并新增装配与应用端到端测试。实际文件名与命令随实现提交，本文不声称这些新测试已经通过。

本计划完成的判定是：平台中选择S01后，经通用prepare检查进入ready，点击运行可以完成正式工艺并获得独立验收结果；更换为另一份使用相同能力的有效场景配置，不需要重写装配器。模块能单独运行、目录可见或PLC界面能显示端口，都不构成这个完成标准。

实施结果：通用编译/装配、受控会话入口、三维与 PLC 同源快照已接入；S01 正式三盘 36 件候选仿真通过独立目标验收。运行证据见 [008-s01-runtime.json](evidence/008-s01-runtime.json)。设备重命名、单盘配置、取消准备和受控停止均有回归测试。完整能力边界及命令见[实现说明](../scene-runtime-assembly.md)。本次未修改 public 下的作者契约、节点、坐标和 DSL。


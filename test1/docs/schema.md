# 八类设备的接口与行为契约规范

本规范保留现有 DeviceSpec 的安装锚点、工艺端口、行为能力和资源定义，统一接口方向、参数含义及逐行为执行契约。每类设备以一张行为契约表同时定义行为标识、类型、触发来源、前置／持续条件和完成依据，避免行为清单与条件表分别维护而失配。本文是待实施的目标规范，不表示 DeviceSpec JSON、PLC 或运行器已经支持所有条目。

## 通用约定

- `in/out` 均从设备或设备服务视角描述。安装锚点、取放点、工艺端口不是 PLC 变量，继续分别保存于 `physical_interfaces` 和 `process_ports`。
- 表内 `BOOL/INT/DINT/REAL` 表示建议的 PLC 侧类型。上层 `event/command` 仍可作为 Agent/Runtime 的消息；适配器负责把命令载荷拆为有类型的参数和触发信号，不把 JSON 对象直接塞入一个 REAL。
- BOOL 必须说明是持续状态、持续许可还是请求／通知。一次事件可用有确认的锁存位、序号或队列编码；不能只在一个 PLC 扫描中置 TRUE 后立即清零，否则可能被设备采样漏掉。
- 接口名为语义标识；`runTag` 等名称沿用手稿，实际映射到场景中的 PLC 变量名。别名只对应一个逻辑接口，不产生两个写入者。
- 速度基线采用 m/s，高度采用 m，转角采用 °；`speedFpmTag` 是可选的英制兼容接口。由配置选择一种速度输入，不能让两种单位同时覆盖同一设定值。
- 工件、库位和任务的字符串 ID 在场景／Agent 层保留；PLC 侧可经稳定映射使用 INT/DINT 索引。编号范围、空值和版本必须明确，不用 REAL 表示身份。
- 设备坐标系、关节轴所在坐标系、角度单位和 TCP 偏移必须声明。已有数据中不同轴向约定需经适配转换，不能直接混用。
- “设备局部条件”“物理反馈”和“上层资源授权”分别标明来源。声明了资源容量，不等于执行时已经检查容量；声明了完成效果，不等于可以直接把物料移动到目标。


**行为标识与一致性规则：**

- 行为使用设备内唯一的稳定 `behavior_id`，完整引用为 `device_spec_id + behavior_id`；中文仅作显示名，不用于字符串猜测匹配。
- 下文“行为、执行条件与完成判据”表是各设备的唯一行为清单；每一行均具有对应触发、条件和完成／反馈。生成 JSON 时从同一行生成字段，不再维护另一份不一致的自然语言列表。
- 类型区分：动作是可调用执行单元；复合行为由已登记子行为组成；内部机制由状态或时钟驱动；服务维护资源事务；被动响应由外部执行器触发；观测只发布状态。调度器只能选择配置中明确标记为可调度的动作、复合行为或服务，不能把反馈发布和每步加减速当成生产任务。
- 内部机制、观测和持续行为也有适用／持续条件，但没有一次性成功终点；应发布状态或满足停止判据，不能统一伪造 done。物料与托盘的被动响应不产生本体自主请求。
- 一个上层请求只选择一个顶层行为；复合行为调用子动作时共享上层任务上下文，不再次创建相同外部请求。协议接受、结果确认、故障复位属于公共协议迁移，不与生产行为混为一份任务清单。
- 可选行为必须声明适用配置；模块未启用时该行为不可选，相应接口不必绑定。经任务网关或服务 API 触发的行为需使用上文公共任务上下文，不要求每个 behavior_id 都增加一个独立 BOOL 引脚。

**主动离散动作共用协议：**升降、机械臂任务、转台定位、单件生产和仓储服务可复用下表。各设备的启动接口映射到同一个请求角色；每个动作实例只保留一个有效入口。

| 方向 | 接口信息 | 含义 |
| --- | --- | --- |
| in | `request_id: DINT` | 本次请求标识；参数在接受前保持稳定，接受后由设备快照冻结 |
| in | `execute: BOOL`，或设备专用启动字段 | 新请求触发并保持，直到观察到接受；撤销后才能形成下一次请求 |
| out | `accepted: BOOL` | 已接受当前请求；保持到请求撤销，避免快速动作的接受信息丢失 |
| out | `busy: BOOL` | 当前请求尚未终止；运动停止但任务暂停时仍可能为 TRUE |
| out | `done: BOOL` | 当前请求成功完成，结果保持到下一次请求被接受；不等同于一般“空闲” |
| out | `result_id: DINT` | 当前完成／失败结果关联的请求标识 |
| out | `error: BOOL`、`error_code: INT` | 当前请求失败或设备故障及原因；与普通等待、正常阻塞区分 |
| in | `reset: BOOL` | 请求清除可复位故障；仅在故障原因解除且设备允许复位时生效 |

新请求必须满足：请求标识有效、启动信号有效、设备可接受、参数合法及所需资源获准。重复请求不能重复启动。完成必须属于本次已接受请求；空闲时的初始状态不能被误当作本次完成。未接受超时、执行超时和动作完成分别处理，超时不自动释放仍被占用的资源。

持续运行的输送设备不强制套用整套任务协议；按物料下发的离散运输任务可在外层使用它。物料与托盘是被动对象，其状态由物理／交接服务更新，不添加虚假的自主执行入口。

---

**1. 传送带：连续输送与可选分区积放**

基础定义：[conveyor_1.json](E:/project/AgenticComponents/test1/docs/scene1/device_specs/conveyor_1.json)。参考：[普通皮带](E:/project/Open-Industry/examples/parts/belt-conveyor/part.js:678)、[Flex Conveyor 分区积放](E:/project/Open-Industry/examples/parts/flex-conveyor/part.js:359)。

物理／工艺接口：保留四个底部安装锚点和 `flow_input/flow_output`。停留区由独立 `zones/stop_points` 描述，包含几何范围、检测位置、物料长度约束和占用规则，不混入安装锚点。

| 方向 | 接口信息 | 含义 |
| --- | --- | --- |
| in | `runTag: BOOL` | 持续运行许可；FALSE 将目标速度置零，实际速度按减速曲线下降 |
| in | `speedTag: REAL` | 目标表面速度，m/s；负值表示反向，是否允许反向由设备配置限定 |
| in | `speedFpmTag: REAL`（可选） | 英制速度设定；仅在 FPM 模式下生效 |
| in | `release_waiting_material: BOOL` | 保留手稿改型；作为末端持续放行许可，TRUE 不表示每次扫描都创建一条运输任务 |
| out | `runningTag: BOOL` | 实际表面速度超过静止容差；减速过程中仍可能为 TRUE |
| out | `actual_speed: REAL` | 实际表面速度，m/s；区别于目标速度 |
| out | `velocityTag: REAL`（可选） | Open-Industry 风格的比例速度反馈，需声明标定关系；不默认等于 m/s |
| out | `pulseTag: BOOL`（可选） | 表面每行进指定距离产生编码脉冲；采样分辨率应满足配置 |
| out | `encoderTag: REAL`（可选） | 累计有符号表面行程，m；不直接等于物料位移 |
| out | `blocked: BOOL` | 存在因下一分区／下游不可接收而等待的物料；空带停机不算阻塞 |
| out | `part_ready: BOOL` | 出口交接区域当前有待交接物料；物料交接后清除 |
| out | `capacity_available: BOOL` | 当前入口及容量允许接收；改为持续状态，上层可另发“容量恢复”事件 |
| out | `stop_point_occupied_i: BOOL` | 第 i 停留区的当前占用；按区域展开为标量标签，避免一个 BOOL 表示所有区 |
| out | `stop_point_released_i: BOOL`（可选通知） | 第 i 区释放通知；采用锁存确认或事件序号，不与当前空闲状态混用 |
| out | `done: BOOL`（仅离散运输任务） | 指定工件完成指定交接；必须关联任务 ID，连续空转没有全局完成事件 |

`i` 是模板索引，实际标签应展开为 `..._1`、`..._2` 等。通知可能在同一仿真步发生多次时，由 Runtime 排队并记录事件序号；不能靠一个脉冲位保存任意数量事件。

**行为、执行条件与完成判据：**

| behavior_id | 行为／类型 | 接口或触发来源 | 前置条件／持续条件 | 完成／反馈依据 |
| --- | --- | --- | --- | --- |
| `accept_material` | 接收物料／交接动作 | 入料交接任务或接收授权 | 入口可用、容量含预留仍有余量、物料类型和尺寸兼容、交接授权有效 | 物料确实进入入口区，提交归属与占用 |
| `advance_to_next_stop_point` | 区间推进／内部机制 | 本区检测到物料或下一分区释放 | 已启用分区模式；本区有料、下一区可接收、对应驱动许可有效 | 观测到物料进入下一检测区后更新两区占用；每次迁移可发事件 |
| `transport_to_exit` | 运输至出口／复合行为 | 指定物料的运输任务 | 目标物料已被接收、方向及路径有效、所经分区允许推进；遇阻塞等待 | 指定物料到达出口交接区并发布 part_ready；不等同于已交给下游 |
| `release_material` | 出口交接／动作 | release_waiting_material 持续许可及交接任务 | 出口有指定物料、许可有效、下游容量已预留、放行间隔满足 | 物料离开本设备且下游确认接收，释放本设备占用 |
| `start_conveying` | 连续运行／持续动作 | runTag=TRUE | 运行许可和速度设定有效；允许空转；启用积放时服从各区门控 | 持续发布实际速度；无单次 done，停止由 stop_conveying 判断 |
| `set_speed` | 调整速度／动作 | 选定单位的速度设定变化 | 只有一个速度来源、数值有限且在允许范围、运行模式有效 | 实际速度在允许误差内达到新设定；受阻或禁用时不伪报到速 |
| `stop_conveying` | 受控停止／动作 | runTag=FALSE 或目标速度为零 | 适用于运行中或已静止状态；按配置执行减速，保留仍在带上的物料 | 实际表面速度低于静止容差；已静止可幂等完成 |
| `reverse_conveying` | 反转／动作 | 选定速度设定改变符号 | 设备和工艺允许反向；若为积放模式，其规则必须支持反向 | 先减速至零，再达到反向速度；第一版单向积放拒绝该请求 |
| `zone_accumulation` | 分区积放／内部机制 | 分区检测或下游状态变化 | 启用独立分区驱动及检测；产品尺寸与区间配置兼容 | 按占用与下区状态持续更新各区速度和 blocked，无全局 done |
| `meter_release` | 出口间隔放行／内部机制 | 出口检测、许可或仿真计时变化 | 启用间隔放行；有待放物料、放行许可有效、距上一件离开已达到间隔 | 允许一件离开后更新放行计时；release_material 负责最终交接 |
| `publish_drive_feedback` | 发布驱动反馈／观测 | 每个仿真步 | 反馈字段已配置；由实际表面速度及仿真时间计算 | 更新 runningTag、actual_speed 和启用的速度／编码反馈，无动作 done |

关键参数：加减速时间、速度单位、停留区几何、最大负载、容量、恢复阈值及放行间隔。加减速是 set_speed、stop_conveying 和 reverse_conveying 的执行机制，不另作为可调度生产任务。对同次速度输入变化，由唯一命令解释器分派：零目标为停止、跨符号为反转、同向变化为调速、静止到运行由连续运行入口处理；不能把同一输入重复创建为多项独立任务。连续输送的 runningTag 不等于某个 transport_to_exit 已完成。

普通皮带／滚筒的运行行为与分区积放按实际驱动模式选择；没有独立分区驱动时，不暴露 advance_to_next_stop_point、zone_accumulation 等分区行为。容量判断引用持续状态，不引用一次性 capacity_available 事件。数量容量和真实占用分别检查。

---

**2. 升降台：高度定位与可选横移模块**

基础定义：[lift_table_1.json](E:/project/agent/docs/business/SimulationSchema/1.DeviceSpec/lift_table/lift_table_1.json)。参考：[Gantry 位置控制](E:/project/Open-Industry/examples/parts/gantry/part.js)、[Chain Transfer 抬升](E:/project/Open-Industry/examples/parts/chain-transfer/part.js:237)。Open-Industry 无一一对应的独立升降台，以下为本项目拟定义。

物理／工艺接口：保留 `lower_dock/upper_dock/platform` 和 `flow_input/flow_output`，明确平台与交接口当前世界高度。容量基线为 1，平台为互斥资源。

| 方向 | 接口信息 | 含义 |
| --- | --- | --- |
| in | `move_to_level: REAL` | 保留手稿 REAL 改型，明确表示目标高度，m；不再同时携带字符串 target |
| in | `target_level: INT`（层号模式） | 目标层编号，由 `height_levels` 映射到高度；配置选择层号或高度模式，二者不同时驱动 |
| in | `execute: BOOL`、`request_id: DINT` | 目标参数写好后发起一次升降请求，采用公共握手 |
| in | `enableTag: BOOL` | 主升降动作使能；失能时拒绝新请求，运行中按已实现的减速保持策略处理 |
| in | `reset: BOOL` | 符合恢复条件时复位故障，不直接使平台瞬移或释放载荷 |
| out | `actual_height: REAL` | 实际平台高度，m |
| out | `moving: BOOL` | 平台当前是否仍在运动；不同于任务是否未完成 |
| out | `at_level: BOOL` | 实际高度在目标容差内且速度已稳定；空闲状态也可能成立 |
| out | `accepted/busy/done/error: BOOL`、`result_id: DINT`、`error_code: INT` | 公共动作反馈；done 必须对应本次已接受任务 |
| in | `popupTag: BOOL`（可选横移模块） | 辅助链条机构抬升／下降；不能同时作为主高度轴的第二个控制来源 |
| in | `speedTag/speedFpmTag: REAL`（可选横移模块） | 横向输送速度，按单位模式选择；不是升降轴速度 |
| out | `transfer_ready: BOOL`（可选横移模块） | 主平台和辅助机构满足交接位置，且允许横移 |

主轴速度继续使用 `lift_speed_mps` 参数；辅助横移只有在实际模型包含相应机构与执行代码时启用。

**行为、执行条件与完成判据：**

| behavior_id | 行为／类型 | 接口或触发来源 | 前置条件／持续条件 | 完成／反馈依据 |
| --- | --- | --- | --- | --- |
| `accept_material` | 接收物料／交接动作 | 入料交接任务 | 平台停稳、来源接口高度匹配、平台容量可用、交接权限有效 | 物料稳定进入平台并完成归属转移 |
| `lift_to_level` | 升降定位／动作 | execute 与有效 request_id | 新请求、设备可接受、使能有效、层号存在或高度在行程内、平台资源获准 | 实际高度误差和速度满足阈值，报告本次 done |
| `release_material` | 释放物料／交接动作 | 出料交接任务 | 平台停稳且目标高度匹配、下游可接收并已预留 | 下游确认接收后释放平台占用 |
| `hold_lift` | 减速保持／动作 | enableTag 失能或经授权的保持请求 | 设备声明可保持在途动作；载荷和资源继续保留 | 实际速度降至静止阈值并保持；上层升降任务尚未完成 |
| `resume_lift` | 恢复升降／动作 | enableTag 恢复且存在被保持任务 | 原任务有效、故障条件解除、资源仍获准、目标未被覆盖 | 进入原任务执行阶段；最终到位由 lift_to_level 判断 |
| `raise_transfer_chains` | 抬升辅助链条／可选动作 | 可选模块 popupTag=TRUE | 启用独立横移模块；主平台停稳、辅助行程及资源允许 | 辅助机构实际到达上位，不仅按计时推断 |
| `lower_transfer_chains` | 下降辅助链条／可选动作 | 可选模块 popupTag=FALSE | 启用横移模块；物料已满足支承／交接条件，下降不会破坏持有关系 | 辅助机构实际到达下位 |
| `transfer_material` | 横向输送／可选动作 | 横移交接任务与有效速度设定 | 主平台停稳、辅助机构到所需位置、transfer_ready、路径及下游可用 | 指定物料交接完成；停机仅反馈静止，不自动算交接成功 |

目标层字符串在 Agent/API 层映射为层号或高度。lift_to_level 同时承载“受控升降”的含义，不另建一个同义行为。辅助机构与主轴必须有不同执行所有权；模块未配置时三个横移相关行为均不适用。取消在途任务尚未列入基线，需单独定义取消入口、停止与资源处置后再扩展。

---

**3. 出料口／物料源工位：按需生产与节拍出料**

基础定义：[material_source_station_1.json](E:/project/agent/docs/business/SimulationSchema/1.DeviceSpec/material_source_station/material_source_station_1.json)。参考：[Spawner](E:/project/Open-Industry/examples/parts/box-spawner/behavior.ts)。此处“出料口”是向产线提供物料的源端；产线末端移除物料是另一种 Sink。

物理／工艺接口：保留 `output/buffer_area` 和 `flow_output`。保留生产周期、缓冲容量、按需模式和取走后释放策略。

| 方向 | 接口信息 | 含义 |
| --- | --- | --- |
| in | `runTag: BOOL` | 持续生产许可；第一版关闭后暂停周期推进、拒绝新请求，保留已接受任务及容量预留，恢复后继续 |
| in | `produce_request: BOOL`、`request_id: DINT`（按需模式） | 请求生产一件；持续 TRUE 不连续创建重复请求 |
| in | `reset: BOOL` | 故障原因消失后请求复位 |
| out | `countTag: DINT` | 本方案定义为实际成功生成／呈现的累计数量；与 Open-Industry 的生成请求计数区分 |
| out | `material_available: BOOL` | 出口当前有可取物料，取走后清除；上层另发一次到料事件 |
| out | `empty: BOOL` | 当前缓冲区无可取物料；不等同于永久耗尽原料 |
| out | `buffer_count: INT` | 当前缓冲物料数量 |
| out | `accepted/busy/done/error: BOOL`、`result_id: DINT`、`error_code: INT` | 按需生产的请求与结果反馈；连续生产使用每件物料的事件日志和计数 |

**行为、执行条件与完成判据：**

| behavior_id | 行为／类型 | 接口或触发来源 | 前置条件／持续条件 | 完成／反馈依据 |
| --- | --- | --- | --- | --- |
| `produce_material` | 生产物料／动作 | produce_request；节拍模式由到期事件创建一次内部请求 | 生产许可有效、未暂停、产品及参数合法、缓冲容量含预留足够；按需为新请求，节拍为计时到期 | 实际生成成功，更新缓冲数量并且仅计数一次；不是仅发出 spawn 请求 |
| `present_material` | 呈现／出料／交接动作 | 生成完成或呈现任务 | 缓冲区有指定物料、出口空间可用、交接授权和可配置下游联锁有效 | 物料到达出口并可取，更新 material_available；取走后再释放相应占用 |
| `pause_production` | 暂停生产／动作 | runTag=FALSE 或手动暂停 | 适用于有无在途任务；拒绝新请求，保留已接受任务和预留 | 停止周期推进，不删除已有物料，也不把暂停当作生产完成 |
| `resume_production` | 恢复生产／动作 | runTag 恢复且手动暂停已解除 | 原任务或生产模式有效、设备无阻止恢复的故障、资源状态允许 | 继续保留的周期；重复恢复不新建同一生产任务 |
| `schedule_production_cycle` | 固定／随机节拍／内部机制 | 仿真时钟和生产许可变化 | 启用节拍模式、周期正且有限；随机策略使用可复现随机源 | 按节拍生成内部生产请求；暂停时冻结剩余时间，不补发停机欠账 |
| `publish_source_state` | 发布源端状态／观测 | 生成、呈现、取走或状态更新 | 统计来自实际成功生成和实际缓冲占用 | 更新 countTag、buffer_count、empty、material_available 及任务结果 |

产品参数、颜色和属性变化是 produce_material 的参数化策略，不是独立可调度行为。原固定／随机节拍统一归入 schedule_production_cycle；正常等待容量不视为故障。若增加“每次使能立即出一件”，应声明独立模式并避免与恢复原周期同时触发。

---

**4. 机械臂：可组合动作与任务执行**

基础定义：[robot_arm_1.json](E:/project/AgenticComponents/test1/docs/scene1/device_specs/robot_arm_1.json)。参考：[Six-Axis Robot](E:/project/Open-Industry/examples/parts/six-axis-robot/part.js:325)。

物理／工艺接口：保留底部安装锚点、`flow_input/flow_output`、关节轴与限位、GLB 节点映射和 TCP。工艺抓放点与模型安装点分开，TCP 偏移必须实际进入运动求解。

| 方向 | 接口信息 | 含义 |
| --- | --- | --- |
| in | `commandTag: INT` | 选择预定义任务／动作序列；参数表包含取放目标及关节／笛卡尔路径绑定 |
| in | `start_pick: BOOL`、`request_id: DINT` | 原 start_pick 事件的 PLC 投影；作为公共 execute 角色，默认选择抓放任务，或执行 commandTag 指定任务 |
| in | `pause_pick: BOOL` | 保留原含义：持续阻止启动新抓取任务，不自动暂停在途动作 |
| in | `resume_pick: BOOL`（兼容入口） | 清除同一暂停锁存的请求；与 pause_pick 的写入规则统一，冲突输入应拒绝 |
| in | `enableTag: BOOL` | 控制在途运动使能；具备减速保持能力时暂停当前任务，并在恢复后继续 |
| in | `gripperTag: BOOL`（手动／无任务表模式） | 独立夹具开关；任务表模式由任务控制，二者不能同时写夹具 |
| in | `in1Tag～in4Tag: BOOL`（可选） | 工艺任务中可等待的外部条件，如目标就绪或区域许可 |
| in | `reset: BOOL` | 允许状态下复位故障，保留或显式处置仍持有的工件 |
| out | `accepted/busy/done/error: BOOL`、`result_id: DINT`、`error_code: INT` | 公共握手；本方案 done 表示当前任务成功，不沿用 Blend 提前可接命令的含义 |
| out | `out1Tag～out4Tag: BOOL`（可选） | 可配置阶段反馈，如已离开取料区、已放下工件；明确保持和清除规则 |
| out | `holding_material: BOOL` | 来自实际夹持／持有关系的反馈，不等同于 gripperTag 的命令值 |

在兼容 API 中仍可接收 `start_pick/pause_pick/resume_pick` 事件，适配到上述 PLC 语义；不能同时将 API 与 PLC 作为两个独立任务生产者。暂停命令采用单一锁存：pause 有效期间不允许 resume 清除，或在命令网关拒绝冲突；策略需固定。

**行为、执行条件与完成判据：**

| behavior_id | 行为／类型 | 接口或触发来源 | 前置条件／持续条件 | 完成／反馈依据 |
| --- | --- | --- | --- | --- |
| `execute_job` | 执行预定义任务／复合行为 | commandTag、start_pick 和新 request_id | 设备可接受、未暂停接单、任务编号及参数有效、资源获准 | 选定任务的必需子行为均成功，终态满足契约后报告本次 done |
| `pick_and_place` | 抓放／复合行为 | execute_job 选择抓放任务，或经同一网关直接调用 | 设备空闲、取料点有指定工件、夹具为空、未暂停接单、目标及资源合法 | 取料、移动、放置等子行为完成；实际物料交接成立 |
| `move_to_pose` | 移动／动作 | 任务中的 Move 或经网关调用 | 目标位置／姿态及关节限制合法、有可执行路径、使能有效 | 实际 TCP 位置、所需姿态和速度满足阈值；IK 未收敛不算完成 |
| `grip` | 抓取／动作 | 任务中的 Vacuum on 或有效手动夹具命令 | 指定工件存在且归属本任务、夹具为空、物料和载荷兼容、接近／接触条件满足 | 实际持有关系建立，holding_material 为真 |
| `release` | 放置释放／动作 | 任务中的 Vacuum off 或有效手动释放命令 | 当前持有指定物料、目标容量已预留、姿态及释放条件满足 | 工件与目标完成有效交接；夹具命令置零本身不足以证明成功 |
| `wait_time` | 定时等待／动作 | 任务中的 Wait | 时长合法且等待策略已配置 | 按仿真时间达到有效等待时长；失能保持时按约定冻结计时 |
| `wait_signal` | 等待外部信号／动作 | 任务中的 Wait for | 信号已绑定且类型正确、期望值和超时策略明确 | 实际信号满足期望；超时走失败分支 |
| `set_output` | 设置任务输出／动作 | 任务中的 Set | 输出已绑定、取值合法且由本任务拥有写入权 | 输出提交成功，状态按声明规则保持或清除 |
| `pause_pick_intake` | 暂停接收抓取／控制动作 | pause_pick=TRUE | 适用于当前接单模式，不改变在途动作阶段 | 阻止新抓取被接受；不宣称机械臂已经停稳 |
| `resume_pick_intake` | 恢复接收抓取／控制动作 | 兼容 resume_pick 或暂停许可解除 | 暂停锁存允许解除、没有冲突暂停输入 | 允许新的抓取请求，原任务不重复执行 |
| `hold_motion` | 暂停在途运动／控制动作 | enableTag 失能 | 设备具有减速保持实现；当前任务、工件和资源继续保留 | 运动减速至保持状态，任务仍未终止 |
| `resume_motion` | 恢复在途运动／控制动作 | enableTag 恢复且存在保持任务 | 原任务有效、资源仍获准、故障条件已解除 | 继续原阶段，不重复已经完成的 grip/release |
| `publish_robot_state` | 发布动作与夹持状态／观测 | 仿真步、任务及持有关系变化 | 状态来源与接口绑定有效 | 更新 accepted/busy/done/error、holding_material 与阶段输出 |

execute_job 是外部任务入口，pick_and_place 可作为其中一个任务；两者不能把同一请求执行两次。原“任务启停”分别映射到接单控制与在途保持，停止接单不等于停止运动。速度、加速度和过渡方式是 move_to_pose 的参数与执行机制。第一版 done 以当前任务成功为准；Open-Industry Blend 的提前接单含义应另用 ready_for_next 表达。

---

**5. 旋转台：工位定位与可选台面输送**

基础定义：[rotary_table_1.json](E:/project/agent/docs/business/SimulationSchema/1.DeviceSpec/rotary_table/rotary_table_1.json)。参考：[Turntable Conveyor](E:/project/Open-Industry/examples/parts/turntable-conveyor/part.js:513)。

物理／工艺接口：保留 `station_a/station_b`、`flow_input/flow_output`。工位编号、目标角度、旋转轴、物料支承区域和交接姿态分别声明；工位坐标应随台面姿态更新。

| 方向 | 接口信息 | 含义 |
| --- | --- | --- |
| in | `target_station: INT` | 工位编号，通过 stations 映射到角度；不把字符串工位名直接作为 REAL |
| in | `angleTag: REAL`（角度模式） | 任意目标角度，°；配置选择工位或角度模式，两者不同时驱动 |
| in | `rotate_to_station: BOOL`、`request_id: DINT` | 原 command 的 PLC 投影；参数先写入，再请求一次定位，映射公共 execute 角色 |
| in | `enableTag: BOOL` | 转动使能；失能时按声明的减速保持策略处理，再使能后可继续原动作 |
| in | `reset: BOOL` | 故障原因解除且允许恢复时复位 |
| out | `actual_angle: REAL` | 当前实际角度，°，用于到位和交接检查 |
| out | `occupied: BOOL` | 当前台面／指定交接区是否存在物料；作用范围必须在配置中固定 |
| out | `rotating: BOOL` | 实际角速度是否超过静止容差 |
| out | `at_station: BOOL` | 台面达到所选目标且已稳定；这是状态，不单独代表某次请求成功 |
| out | `accepted/busy/done/error: BOOL`、`result_id: DINT`、`error_code: INT` | 公共任务反馈，done 关联当前定位请求 |
| in | `speedTag/speedFpmTag: REAL`（可选输送模块） | 台面输送速度；纯定位转台不提供该接口 |
| in | `transfer_enable: BOOL`（可选输送模块） | 台面出入料许可，与旋转使能分别定义 |

**行为、执行条件与完成判据：**

| behavior_id | 行为／类型 | 接口或触发来源 | 前置条件／持续条件 | 完成／反馈依据 |
| --- | --- | --- | --- | --- |
| `accept_material` | 接收物料／交接动作 | 入料交接任务 | 转台停稳且与来源对齐、容量可用、交接授权有效 | 物料进入支承区域并完成归属转移 |
| `rotate_to_station` | 工位／角度定位／动作 | rotate_to_station 请求与目标参数 | 新请求、设备可接受、工位或角度有效、使能和旋转区域许可有效 | 实际角度及角速度满足阈值，at_station 有效并报告本次 done |
| `release_material` | 出料交接／动作 | 出料交接任务 | 台面停稳、出口对齐、下游及容量预留有效 | 下游确认接收指定物料后更新 occupied |
| `hold_rotation` | 减速保持／动作 | enableTag 失能 | 支持在途保持；支承物料和相关资源继续有效 | 实际转动降至静止阈值，原定位任务仍未完成 |
| `resume_rotation` | 恢复转动／动作 | enableTag 恢复且有保持任务 | 原目标有效、故障解除、所需资源仍获准 | 继续向保留目标转动；最终结果由 rotate_to_station 判断 |
| `convey_on_deck` | 台面输送／可选持续动作 | transfer_enable 和有效速度设定 | 配置实际输送模块、台面停稳、转台与目标对齐、输送许可有效 | 发布输送状态；物料交接由 release_material 确认，无独立全局 done |
| `publish_turntable_state` | 发布角度与占用／观测 | 仿真步、占用或任务变化 | 从实际角度、速度和支承区域观测状态 | 更新 actual_angle、rotating、at_station、occupied 和任务结果 |

允许空载定位，occupied 不是 rotate_to_station 的通用必需条件。加减速属于定位和保持的执行机制。纯定位台不启用 convey_on_deck；配置输送模块时也不能把输送停止直接当作交接完成。

---

**6. 仓储柜：库位预留与存取服务**

基础定义：[storage_rack_1.json](E:/project/agent/docs/business/SimulationSchema/1.DeviceSpec/storage_rack/storage_rack_1.json)。参考：[Rack](E:/project/Open-Industry/examples/parts/rack/part.js:197) 只提供静态货架与碰撞结构，没有以下存取接口。

本节接口属于仓储服务或逻辑控制器。普通货架本身不执行搬运；机器人、AGV 或升降机构完成物理存取，仓储服务负责库位、预留和交接确认。

物理／工艺接口：保留 `cell_input/cell_output` 和 `flow_input/flow_output`；每个库位具有稳定 ID、位置、允许物料类型、容量及状态。初始 3×3 共 9 个库位，数量由配置确定。

| 方向 | 接口信息 | 含义 |
| --- | --- | --- |
| in | `cell_id: INT` | 当前操作的库位编号，通过绑定表映射到 A1 等业务 ID |
| in | `material_id: DINT`、`owner_task_id: DINT` | 当前物料及任务身份；使用登记表映射，不把任意字符串强制转换成数字 |
| in | `reserve_request: BOOL` | 请求为指定任务预留库位 |
| in | `store_request: BOOL` | 发起本次入库交接；不直接把物料位置改写为库位位置 |
| in | `release_request: BOOL` | 请求出库，等待搬运设备取走与交接确认 |
| in | `cancel_reservation: BOOL` | 请求取消尚未完成交接的有效预留；不能清除仍有物料的真实占用 |
| in | `request_id: DINT`、`reset: BOOL` | 公共请求关联与故障复位；同一请求只允许一个操作入口 |
| out | `reservation_granted: BOOL`、`reservation_id: DINT` | 预留结果及关联标识，明确授权给哪个任务 |
| out | `cell_available: BOOL` | 所选库位可供新的合法任务预留；已被其他任务预留时即不可用 |
| out | `cell_full: BOOL` | 所选库位实际容量已满；“有预留”与“已放入物料”分开表示 |
| out | `free_cells: INT` | 当前可预留库位数，排除已占用和有效预留 |
| out | `stored/released: BOOL` | 入库／出库成功的锁存结果，关联 result_id；上层同步产生相应业务事件 |
| out | `accepted/busy/done/error: BOOL`、`result_id: DINT`、`error_code: INT` | 当前仓储操作的公共结果；不能代替搬运设备自身的完成反馈 |

**行为、执行条件与完成判据：**

| behavior_id | 行为／类型 | 接口或触发来源 | 前置条件／持续条件 | 完成／反馈依据 |
| --- | --- | --- | --- | --- |
| `reserve_cell` | 预留库位／服务 | reserve_request 与当前任务／库位参数 | 库位有效、实际容量及已有预留允许、物料兼容、任务身份有效 | 原子建立预留，返回 reservation_granted 和 reservation_id |
| `store_to_cell` | 入库交接／服务 | store_request 和搬运方的交接反馈 | 任务持有目标预留、搬运方拥有物料、尺寸及载荷条件满足 | 实际放置与交接确认后，预留转为占用，发布 stored |
| `release_from_cell` | 出库交接／服务 | release_request 和接收方反馈 | 库位存在指定物料、任务获出库权限、接收方和目标可用 | 物料离开并由接收方确认后释放占用，发布 released |
| `cancel_cell_reservation` | 取消预留／服务 | cancel_reservation | 预留属于当前任务、无不可撤销交接、没有必须保留的真实占用 | 只撤销指定预留，不修改物料位置或其他任务 |
| `query_cell_state` | 查询库位／服务 | 查询指定 cell_id 的 API 或状态读取 | 查询编号与状态版本有效 | 返回确认过的占用、预留和任务关联信息 |
| `publish_storage_state` | 发布仓储状态／观测 | 预留、交接、取消或状态变化 | 实际占用、预留与执行反馈已对齐；异常期间保留未知或在途状态 | 更新 cell_available、cell_full、free_cells、结果及错误 |

reserve_cell、store_to_cell、release_from_cell 的完成确认已分别包含在对应行，不能再给“交接确认”添加无条件成功的旁路。异常保留是公共故障处理策略，不是搬运行为。first_available 是上层默认选择策略；普通货架仍由机器人或 AGV 完成物理移动。

---

**7. 物料：被动对象与状态观测**

基础定义：[workpiece_1.json](E:/project/AgenticComponents/test1/docs/scene1/device_specs/workpiece_1.json)。参考：[Box](E:/project/Open-Industry/examples/parts/box/behavior.ts) 的被动货物与物理属性。

物理／工艺信息：保留安装／布局锚点和质量、形状、尺寸等属性；抓取与稳定放置位置位于 `process_geometry`。`grasp_surface/bottom` 等旧引用需要映射到真实存在的几何区域或标准角色，不能保留悬空引用。

以下 out 接口为运行时观测投影，由抓取器、物理或物料服务发布，不表示每件物料自带 PLC。物料数量大时，通过选择物料 ID 的查询或内部记录表达，避免给每件动态物料永久分配一组硬件 I/O。

| 方向 | 接口信息 | 含义 |
| --- | --- | --- |
| in | 无主动运动命令 | 物料不自行执行 start/execute；由搬运设备或输送行为引用 |
| out | `picked: BOOL`（通知投影） | 本次实际建立持有关系的锁存通知，带事件／任务关联；不是每个抓取命令都算成功 |
| out | `carried: BOOL` | 当前物料是否被有效持有，属于持续状态 |
| out | `placed: BOOL` | 当前物料已完成有效放置并满足配置的稳定条件；上层可另发放置事件 |
| out | `holder_id: DINT` | 当前持有设备／载具的映射 ID，0 表示未被持有 |
| out | `location_id: DINT` | 当前确认的位置或工艺区域；未知位置必须有明确编码 |

**行为、执行条件与完成判据：**

| behavior_id | 行为／类型 | 接口或触发来源 | 前置条件／持续条件 | 完成／反馈依据 |
| --- | --- | --- | --- | --- |
| `be_picked` | 被抓取／被动响应 | 外部夹具实际抓取 | 物料存在且可抓、几何可接触、无冲突持有或预留、夹具及载荷兼容 | 实际持有关系建立，发布 picked 并更新 carried/holder_id |
| `be_conveyed` | 被输送／被动响应 | 外部输送面运动与实际接触 | 物料与输送面具有有效接触／支承；不被冲突执行器独立驱动 | 实际位置及工艺区域更新；目标到达由外层运输任务确认 |
| `be_carried` | 被携带／被动响应 | 持有者执行运动 | 有效持有关系仍成立，身份与任务关联一致 | 按声明持有模型更新姿态；持续过程无本体任务 done |
| `be_placed` | 被放置／被动响应 | 外部放置及交接过程 | 目标兼容、容量可用、支承和位置满足要求；can_stack=false 时禁止把堆叠当合法目标 | 实际放置和交接成立，更新 placed/location_id |
| `be_released` | 被释放／被动响应 | 持有者解除实际持有关系 | 释放者确为持有者且获准，按放置或自由释放模式检查条件 | 清除持有关系；自由释放不自动等于稳定放置成功 |
| `respond_to_physics` | 响应重力与接触／被动机制 | 物理仿真步 | 已配置实际物理执行，质量、形状和约束有效 | 刚体位置、接触和支承按物理结果更新，无本体任务 done |
| `publish_material_state` | 发布物料状态／观测 | 位置、持有或交接变化 | 来源有效，区分持续状态与一次通知 | 更新 picked/carried/placed、holder_id、location_id 和事件关联 |

这些标识描述外部执行器或物理运行时负责的响应，不是物料的自主 PLC 动作。动画时间结束不构成 picked/placed 的成功依据。保留 passive_subject 定位，不因统一格式给物料添加启动命令。

---

**8. 物料托盘／载具：槽位、承载与被动随动**

基础定义：[carrier_tray_1.json](E:/project/AgenticComponents/test1/docs/scene1/device_specs/carrier_tray_1.json)。参考：[Pallet](E:/project/Open-Industry/examples/parts/pallet/behavior.ts)。本项目是带槽位载具，不能直接等同于 Open-Industry 的叉车托盘。

物理／工艺接口：保留底部安装锚点、`flow_input/flow_output`、载荷表面、3×4 槽位布局、允许物料类别及部分装载策略。每个槽位具有位置和唯一 ID，容量默认 12，由参数控制。

| 方向 | 接口信息 | 含义 |
| --- | --- | --- |
| in | 无托盘自主运动命令 | 由输送机、机械臂或车辆搬运；托盘不自行执行运动 |
| out | `loaded: BOOL` | 当前载具至少装有一件物料；部分装载允许时不等同于满载 |
| out | `unloaded: BOOL` | 当前没有已装载物料；卸载完成的离散事件另写 Runtime 日志 |
| out | `load_count: INT` | 当前已确认装载数量，不包含尚未完成的装载请求 |
| out | `free_slots: INT` | 扣除实际占用和有效预留后的可用槽位数 |
| out | `slot_available: BOOL` | 对查询中指定槽位的可用状态；不能用一位同时表达全部槽位 |
| out | `in_transport: BOOL` | 当前正在被其他执行设备搬运或输送 |
| out | `holder_id: DINT` | 当前搬运者或持有者 ID，由外层运行时更新 |

以上状态由载具／物料服务投影，原 loaded/unloaded 事件仍可保留为状态转移日志。若 PLC 要求独立预约某槽位，可在载具服务增加带 `carrier_id/slot_id/material_id/owner_task_id` 的预留 API；不把该服务命令误认为托盘具备驱动电机。

**行为、执行条件与完成判据：**

| behavior_id | 行为／类型 | 接口或触发来源 | 前置条件／持续条件 | 完成／反馈依据 |
| --- | --- | --- | --- | --- |
| `reserve_carrier_slot` | 预留槽位／服务 | 可选载具服务 API 与任务上下文 | 槽位有效且可用、物料类型兼容、任务身份有效，累计预留不超容量 | 原子建立带任务身份的槽位预留；不增加实际 load_count |
| `cancel_carrier_reservation` | 取消槽位预留／服务 | 可选服务 API 的取消请求 | 预留属于本任务、物料尚未交接到该槽位 | 删除指定未完成预留，不把真实装载清空 |
| `confirm_load` | 确认装载／服务 | 搬运方的装载与交接反馈 | 槽位可用或为本任务预留、无物料归属冲突、类型和声明载荷上限满足 | 物料实际位于槽位并完成交接，预留转占用，增加 load_count |
| `carry_material` | 随动承载／被动响应 | 载具运动、支承或持有关系变化 | 物料已归属载具，或采用明确的物理支承关系 | 按选定模型更新物料与载具相对姿态；持续过程无本体任务 done |
| `release_material` | 卸载确认／服务或被动交接 | 外部执行器取走与接收方确认 | 指定物料属于本载具、目标可用、任务有权限 | 物料转移给接收方后减少 load_count 并释放槽位 |
| `be_transported_loaded` | 整托搬运／被动响应 | 外部机器人、车辆或输送机执行 | 载具可被该执行器搬运、整托质量及外形满足限制、装载关系有效 | 载具及装载物按一致语义移动；外部运输任务确认到达 |
| `publish_carrier_state` | 发布载具状态／观测 | 装卸、预留和运动状态变化 | 实际占用与预留已区分，身份与状态版本有效 | 更新 loaded/unloaded、load_count、free_slots、slot_available、in_transport、holder_id |

装载确认、卸载确认、槽位预留和取消分别具有独立 ID 与条件，不再合并成“预留／装载”。服务 API 不等于托盘拥有运动驱动；未启用预留服务时不暴露两个预留相关行为。状态真值必须选择刚性组合、相对约束或物理支承之一；物料归属及槽位释放不得在任务下发时提前提交。

---

## 补充说明一：输送带的停留点、阻塞与间断输送

这里的“断点”按物料停留点／停止区理解，与程序调试断点不同。

**普通 Belt/Roller Conveyor：**没有通用的离散停留点表。部件设定输送表面速度，货物通过接触与摩擦运动。停止可以由 PLC 使 runTag 为 FALSE 或把速度设为零；也可以通过 [Blade Stop](E:/project/Open-Industry/examples/parts/blade-stop/part.js:203) 的实体挡停器截停物料。后者可能形成有压力积压，不应直接等同于分区无压力积放。传感器读数、PLC 互锁和挡停器共同构成特定产线的停放逻辑。

**Flex Conveyor：**存在可选的分区积放。每节作为一个区，带有光电检测；`accumulate` 开启后，当前区有料、下一区有料且下一区不运行时，当前区停机。末区有料时，需 releaseTag 放行许可及 meterGap 间隔满足才运行；空区仍可运行以接收物料。程序把分区速度数组交给 `ctx.setSurfaceSpeed(...)`。源码见 [分区配置](E:/project/Open-Industry/examples/parts/flex-conveyor/part.js:223)和[分区决策](E:/project/Open-Industry/examples/parts/flex-conveyor/part.js:394)。

Flex 的 `fullTag` 表示首区光电被遮挡，供上料联锁使用，不等于所有分区的统计容量都已满。`releaseTag` 只有实际被 PLC 驱动时才限制放行；未绑定或未被驱动时默认允许释放。这与本项目自动模式下要求明确许可的设计需要通过适配区分。

这不是把物料瞬移到离散坐标，而是分区电机速度与物理运动产生停止和排队。模型需满足分区长度大于产品等适用条件；不能由“开启积放”推导任意形状物料都不会发生接触。

你的 stop_points 可作为容量与调度表示；若使用物理仿真，建议将其落实为检测区域、驱动分区和位置容差，由实际位置／传感器更新占用。仅逻辑占位点与真实独立驱动分区应区分：一条整体驱动皮带不能凭空让中间某一段表面单独停下。

## 补充说明二：参数类型、PLC 接口类型和事件编码

Open-Industry 分别定义设备配置参数与设备 PLC 标签：

| 层次 | 支持内容 | 代码位置 |
| --- | --- | --- |
| 设备配置参数 | number、boolean、string、tag、numberList、color、enum、partRef | [ParamSpec](E:/project/Open-Industry/src/core/parts/partApi.ts:21) |
| 设备标签方向 | `in/out`，从部件视角解释 | [标签接口声明](E:/project/Open-Industry/src/core/parts/partApi.ts:147) |
| 设备标签类型 | `BOOL / INT / DINT / REAL` | [stType](E:/project/Open-Industry/src/core/parts/partApi.ts:167)、[类型校验](E:/project/Open-Industry/src/core/parts/partValidate.ts:210) |
| PLC 语言内部类型 | 还包括其他整数类型、字符串、数组、结构等 | [PLC 类型系统](E:/project/Open-Industry/src/plc/types.ts:25) |

例如：

```js
commandTag: { type: 'tag', dir: 'in', stType: 'INT', default: '' }
```

这里 `type: 'tag'` 表示这个配置字段保存一个 PLC 标签名；`stType: 'INT'` 表示该标签承载整数。`waypoints` 这样的 numberList 是设备配置，不等于同一个标签可以接收二维数组。

当前设备标签桥接支持四种标量类型，不能据此说 PLC 语言只有四种类型，也不能因为 PLC 内部支持 STRUCT 就直接给部件标签传任意结构体。复杂目标应在上层保留语义对象，再由绑定／适配器拆成任务号、目标参数与执行握手；需要新增桥接类型时必须同步扩展类型检查和运行器。

## 补充说明三：统一模板与新模型的复用方式

Open-Industry 已有统一的部件结构和执行 API：[PartDefinition](E:/project/Open-Industry/src/core/parts/partApi.ts:1581)、[PackageManifest](E:/project/Open-Industry/src/core/parts/partPackage.ts:1143)、[公开 SDK](E:/project/Open-Industry/packages/part-sdk/README.md)。统一模板的大致形状是：

```js
definePart({
  manifest: { /* 身份、资源、能力声明 */ },
  rig(params) { /* 节点、关节、碰撞与交互结构 */ },
  params: { /* 参数和标签接口 */ },
  geometry(g, params, context) { /* 可选的程序化几何 */ },
  init(ctx) { /* 可选初始化 */ },
  step(ctx) { /* 按仿真时间更新行为 */ },
  dispose(ctx) { /* 可选清理 */ },
})
```

这是结构示意，不能直接运行；具体能力和回调需遵守 SDK。`rig` 为结构与运动学定义，支持渲染和 FK／IK；`geometry()` 是可选几何生成，通常在参数变化时调用；`step()` 读取 PLC 输出值和设备状态，不接收 PLC 源码。

复用分三层：

1. **同一设备的多个实例**：共享设备包定义，仅改变位姿、尺寸、标签名和实例参数。
2. **同类设备的不同外观或尺寸**：复用行为实现与参数模板，修改 GLB 节点映射、rig、碰撞和 TCP，重新验证实际执行。
3. **不同设备的共同机制**：复用 SDK 与共享模块，例如 [conveyorDrive.js](E:/project/Open-Industry/examples/parts/_shared/conveyorDrive.js) 的驱动坡道与编码反馈、[conveyorUnits.js](E:/project/Open-Industry/examples/parts/_shared/conveyorUnits.js) 的单位接口。源文件可导入受支持的共享模块，构建时打包为独立行为脚本。

各 `part.js` 确实包含设备特有的结构和运动逻辑，因此不是任意 GLB 通用的自动驱动器。它具有结构、接口和共享代码层面的复用，但没有一套覆盖所有工艺的通用声明式动作契约编译器；这正是本项目方法一要进一步补充的层次。

新模型的建模流程建议为：选择最接近的设备能力模板 → 导入 GLB/STEP 或构造几何 → 校准节点、关节轴、限位、TCP 和碰撞体 → 复用或实现行为执行器 → 绑定控制接口与动作契约 → 运行结构检查、握手测试和物理验收。相同能力通常无需从零重写行为；新增能力则需有对应执行实现，不能只在 JSON 中写一个名称。

目录有 `part.js` 时修改该源文件并运行 `npm run build-parts -- <folder>`；普通外部部件使用 manifest.json＋behavior.js，自带示例仍可能使用 rig.json＋behavior.ts。结构检查使用 `npm run check-part -- <folder>`，工艺验证使用项目测试；仅导入模型或通过 schema 不能证明动作完成。

## 落地顺序与验证范围

1. 首先统一参数类型、命令入口、信号状态／事件含义与完成判据；不要同时让旧事件运行器和 PLC 各自推进同一动作。
2. 优先实现传送带启停／速度／积放和机械臂单动作握手，再扩展升降、转台与有限缓存供料。
3. 仓储柜与载具的状态由资源／交接服务维护，物料和托盘保留被动对象定位。
4. 每类行为至少验证正常执行、条件不满足、重复请求、暂停恢复和错误结果；资源争抢与多物料交接再进入场景级测试。

本稿中的接口表是目标规范，实施时需同步修改 DeviceSpec、类型校验、绑定适配器、行为运行器和测试。不能仅增加接口字段后就把“支持暂停”“验证到位”或“资源互斥”标记为已完成。

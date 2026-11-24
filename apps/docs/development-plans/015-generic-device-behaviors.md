# 015 通用设备行为与工艺信号连接

本文规定十类设备的通用行为和信号适配方案。建模时以 [设备接口与行为契约规范](../../../test1/docs/schema.md) 为信号与协议基准，按[设备契约](../../../test1/docs/设备契约.md)落入 DeviceSpec。已有型号文件用于核对迁移差异。逐行为说明及条件绑定见[机械臂](#bind-robot-arm)、[加工机床](#bind-machine-tool)、[出料口](#bind-material-source-station)等设备标题下的第一张表。目录、迁移顺序与分支验收见 [开发计划](015-2026-11-24-device-contract-library.md)。

## 信号契约与按能力裁剪

**规范来源。** [设备接口与行为契约（schema.md）](../../../test1/docs/schema.md) 定义设备视角的输入／输出、各类型接口、行为触发、公共请求协议及完成反馈。[设备契约](../../../test1/docs/设备契约.md) 规定这些定义如何写入 DeviceSpec。[统一条件表达式](../../../test1/docs/统一条件表达式.md) 规定行为条件如何引用端口、观测和授权。三者同时适用。行为合并后，与每个保留入口对应的信号语义和外部握手仍须可追溯。

### 每个端口在模板里写什么

一个 `signal_ports[]` 条目必须包含七个字段。以下是输送带持续运行许可的例子，采用已有独立型号的角色和保持方式。实例 PLC 地址在装配时绑定。

```json
{
  "port_id": "runTag",
  "direction": "input",
  "value_type": "boolean",
  "plc_type": "BOOL",
  "description": "持续运行许可。撤销后目标速度归零，带面按设备减速度停稳。",
  "signal_role": "level_permission",
  "retention": "latest_value"
}
```

| 项目 | 发布和校验规则 |
| --- | --- |
| 标识、方向与引用 | `port_id` 在设备内唯一。设备读取控制器写入的 `input`，设备或服务发布 `output`。行为的 `input_signals`、`output_signals` 逐项解析到同一份设备端口定义，方向须匹配。触发方式、前置／持续条件、完成检查与 I/O 引用随同一稳定 `behavior_id` 发布。 |
| 标量与身份 | PLC 标签桥接采用 `BOOL ↔ boolean`、`INT/DINT ↔ integer`、`REAL ↔ number`。工件、格位、任务等业务 ID 经有版本的登记表映射为规定范围的整数，声明空值与未知值的含义。复杂路径、关节数组、配方或具名端点保留在有类型的 API 载荷或配置中，经网关解析为支持的命令／参数。 |
| 单位与写入者 | 速度基线 m/s、高度 m、转台角度 °。选用 FPM 时声明换算。角度／层号／高度等模式按配置互斥。别名使用同一逻辑入口。手动、PLC、调度器与任务表的输入写入权按模式授予；每个实例端口在同一模式只有一个有效写入者。必须声明设备与关节轴的坐标系、角度单位和 TCP 偏移，有异构坐标约定的型号在适配层转换。 |
| 保持与采样 | 在 `signal_role`、`retention` 和 `description` 中说明持续许可、设定值、实时状态、保持至确认的请求、锁存结果或采样脉冲，以及置位、确认和清除的时机。一次性通知选用带确认的锁存、可关联的序号或队列。编码器脉冲须证明采样分辨率足够。 |
| 运行绑定 | `runtime_execution_contract.signal_management` 使用如下约定， `owner=simulation_engine`、`namespace=instance_id/port_id`、`definition_source=signal_ports`、`spatial_binding=false`、`write_policy=single_writer_per_input`、`plc_mapping=instance_bindings`、`sampling=simulation_step_snapshot`、`unknown_policy=invalid_until_provider_ready`。`status` 按实际接入填写。场景会话可再加场景／运行身份隔离同名端口。 |

### 有限动作怎样握手

下表适用于采用公共离散请求协议的能力。启动参数由同一网关提交并在接受后冻结。设备的专用启动口可以承担 `execute` 角色，例如机械臂的 `start_pick`、转台的 `rotate_to_station`。一次顶层请求使用一个有效启动入口，复合动作的子步骤沿用其请求上下文。

| 设备方向 | 端口 | 规定的时序和含义 |
| --- | --- | --- |
| 入 | `request_id: DINT`、`execute: BOOL` 或专用启动口 | 参数有效、设备可接受且授权成立时提交。请求号和载荷在接受前稳定，触发保持到观察到接受，撤销后才能形成下一次请求。同一请求重复采样只启动一次。 |
| 出 | `accepted: BOOL`、`busy: BOOL` | `accepted` 对应当前请求，保持到请求撤销。`busy` 表示任务尚未终止，减速保持或暂停时仍可能为真。 |
| 出 | `done: BOOL`、`result_id: DINT` | 本次已接受请求的实际完成证据满足后，发布该请求的成功结果。成功锁存至下一次请求被接受，读取方核对结果号。设备上电空闲或工位本来就已到位，单凭这两个状态都不能产生本次成功回执。 |
| 出 | `error: BOOL`、`error_code: INT` | 报告设备故障或本请求失败及原因，结果与请求身份关联。下游暂不可接、普通阻塞和正常等待分别反馈。 |
| 入 | `reset: BOOL` | 仅在原因解除且设备允许时请求复位。接单超时、执行超时、受控停止、成功完成分别处置；故障和超时后继续保留实际持件、占用与预留，直至按契约确认处置。 |

连续空转／发布反馈保留电平和逐件事件；输送带的按件离散输送可在外层采用公共请求协议。被动物料和托盘由外部执行器或交接服务更新状态。API 模式可以通过网关保持请求身份，型号文档须明确其可用入口和 PLC 支持范围。

### 十类设备按哪些端口核对

下表是选型时的接口索引。`schema.md` 有八张类型表，其中托盘表归到 `workpiece` 的承载属性。滑轨、机床、搬运人员是已有项目扩展，沿用上述公共规则并列出各自的扩展来源。下表中“公共”展开为上一节中该动作采用的公共输入和输出。每个型号按实际启用的模块、单位和运行模式选择；完整逐行为触发、条件和反馈以规范原表为依据。

| 类型 | 设备输入（基线与模式） | 设备输出（基线与模式）及关键语义 |
| --- | --- | --- |
| 传送带 | `runTag: BOOL` 持续许可，`speedTag: REAL`（m/s）；可选 `speedFpmTag: REAL` 与之择一。`release_waiting_material: BOOL` 为持续放行许可。定距模块用 `target_distance: REAL`（m），接受时冻结。 | `runningTag: BOOL`、`actual_speed: REAL`（m/s）、`blocked: BOOL`、`part_ready: BOOL`、`capacity_available: BOOL`。选配 `velocityTag: REAL` 需标定，`pulseTag: BOOL` 需采样保证，`encoderTag: REAL` 为有符号带面行程（m）。配置停留区后逐区展开 `stop_point_occupied_i: BOOL`，可选 `stop_point_released_i: BOOL` 为可靠释放通知。有限任务的 `done: BOOL` 关联本次任务；连续运行发布实际状态。 |
| 升降台 | 高度模式 `move_to_level: REAL`（m）或层号模式 `target_level: INT`，通过层高表映射。公共请求，`enableTag: BOOL`。选配横移模块可用 `popupTag: BOOL`、`speedTag: REAL`／`speedFpmTag: REAL`，横移速度独立于主轴。 | 公共结果，`actual_height: REAL`（m）、`moving: BOOL`、`at_level: BOOL`；横移模块可增 `transfer_ready: BOOL`。`at_level` 要求高度误差和速度稳定，本次任务另核对请求号。 |
| 出料口 | `runTag: BOOL` 持续生产许可。按需生产用 `produce_request: BOOL` 和 `request_id: DINT`，保持请求只生产一件。`reset: BOOL` 按故障恢复条件生效。 | `countTag: DINT` 累计实际成功生成／呈送的数量，`material_available: BOOL` 表示出口当前有可取物料，`empty: BOOL`、`buffer_count: INT` 表示当前缓冲。按需任务用公共结果，连续生产用逐件记录与计数。 |
| 机械臂 | `commandTag: INT` 选择任务；`start_pick: BOOL` 和 `request_id: DINT` 构成启动入口。`pause_pick: BOOL` 控制新抓取接单，兼容 `resume_pick: BOOL` 清除同一锁存。`enableTag: BOOL` 控制在途运动使能，`reset: BOOL` 用于复位。手动模式可用 `gripperTag: BOOL`；任务可选 `in1Tag～in4Tag: BOOL`。 | 公共结果、`holding_material: BOOL`（实际持有关系）、可选 `out1Tag～out4Tag: BOOL`（须说明保持与清除）。手动夹具和任务表分配写入权，等待外部输入须有有效采样。 |
| 旋转台 | 工位模式 `target_station: INT` 或角度模式 `angleTag: REAL`（°）。`rotate_to_station: BOOL`、`request_id: DINT` 启动，`enableTag: BOOL`、`reset: BOOL`。选配台面输送可启用 `speedTag: REAL`／`speedFpmTag: REAL` 和 `transfer_enable: BOOL`。 | 公共结果、`actual_angle: REAL`（°）、`occupied: BOOL`、`rotating: BOOL`、`at_station: BOOL`。占用要注明台面或具体区域，到站是状态，分度完成须关联请求。 |
| 仓储柜 | `cell_id: INT`、`material_id: DINT`、`owner_task_id: DINT`。`reserve_request: BOOL`、`store_request: BOOL`、`release_request: BOOL`、`cancel_reservation: BOOL` 按操作择一，公共 `request_id: DINT`、`reset: BOOL`。 | 公共结果、`reservation_granted: BOOL`、`reservation_id: DINT`、`cell_available: BOOL`、`cell_full: BOOL`、`free_cells: INT`。`stored: BOOL`、`released: BOOL` 是按 `result_id` 关联的存取锁存结果。预留与实际占用分别更新。 |
| 物料（含托盘） | 无自主运动命令。装卸、搬运和预留由相应设备或服务发起。 | 按物料观测能力发布 `picked: BOOL`（持有建立后的关联通知）、`carried: BOOL`（持续持有）、`placed: BOOL`（确认放置）、`holder_id: DINT`（0 表示未持有）、`location_id: DINT`（声明未知编码）。承载选项保留 `loaded: BOOL`（至少一件）、`unloaded: BOOL`（盘中已确认装载数为 0）、`load_count: INT`、`free_slots: INT`（扣除占用和预留）、`slot_available: BOOL`（所查槽位）、`in_transport: BOOL`、`holder_id: DINT`（托盘的搬运者）。同一实例共用持有者端口，盘上每件物料仍有自己的身份。 |
| 滑轨（扩展） | S07 使用 `target_position: REAL`（m）、`execute: BOOL`、`request_id: DINT`、`stop: BOOL`、`enable: BOOL`。具名工位由模型解析出目标。 | `actual_position: REAL`（m）、`actual_speed: REAL`（m/s）及请求结果。S07 旧包的 `error_code: DINT` 与公共表建议的 INT 有差异，见下文兼容处理。[滑轨规范](../../../test1/docs/直线滑轨契约.md) |
| 机床（扩展） | S06 当前用 `execute: BOOL`、`request_id: DINT`、`subject_id: DINT`。 | 当前声明 `accepted: BOOL`、`busy: BOOL`、`done: BOOL`、`result_id: DINT`、`error: BOOL`。加工点支承与工件工艺记录是判定数据源。[机床型号契约](../../public/scene/S06/contracts/machine_tool.json) |
| 人物（扩展） | S11 当前用 `execute: BOOL`、`request_id: DINT`，搬运端点和物料来自有类型的载荷。 | 当前声明 `accepted: BOOL`、`busy: BOOL`、`done: BOOL`、`result_id: DINT`、`error: BOOL`、`holding_material: BOOL`。吸附事实来自手部约束。[人物型号契约](../../public/scene/S11/contracts/human_operator.json) |

### 裁剪决定与验收

- **允许按适用性裁剪。** 在型号与能力清单中为每个规范端口记录原规范条目、适用条件、启用／未启用的理由及运行入口。未配置定距、分区或台面输送时，可省其专属端口；只支持角度模式时可省工位号输入。对应行为、条件引用和 PLC 绑定须随配置一起检查。主动／持续／被动的协议范围按上文分别验证。
- **历史缺口单列。** 启用能力所需的端口缺失，或保持语义未验证，登记为待补实现或受限模式。S11 转台采用角度模式，省略 `target_station` 有模式依据；旧包还缺 `enableTag`、`reset`、`error_code`，须分别说明限制。S06 机床和 S11 人物的旧包亦缺 `reset` 和 `error_code`。若要发布完整公共 PLC 请求协议，须补齐并测试。滑轨故障码兼容旧 DINT 时保留旧修订，采用 INT 的新映射须验证所有码值可表示并明确转换版本。
- **声明、支持和观测分别验证。** 例如独立输送带通过 `supported_io` 标明可用子集，某端口出现在 JSON 中仅能证明已声明。场景导入已有方向、类型及引用检查；新模板的规范覆盖、按扫描周期的锁存／撤销及重复请求验证属于实施验收。布尔观测能计算某个条件或为输出端口提供发布值，启用能力规定的外部端口仍要保留。
- **验收用例。** 构建时按“类型＋型号＋模式＋行为”对照规范表和行为 I/O，拒绝缺失适用端口、类型或方向错误、悬空引用、双写者和未经声明的单位转换。执行时覆盖启动持续多扫描只接单一次、撤销后确认释放、成功结果锁存到下一次接受、旧结果号无法放行新请求、故障和阻塞分别反馈、持件复位与超时不误释放，以及低频 PLC 读取仍能收到已声明的离散通知。持续输送空转、物料被动跟随及可选模块关闭也要独立验收。

**分度动作的绑定示例。** 角度模式下，网关先提供 `angleTag: REAL`（°）和 `request_id: DINT`，再置位 `rotate_to_station: BOOL`。转台读取授权、停稳和载荷保持条件；接单后冻结角度。到位检查读 `actual_angle`、`rotating` 和工装约束，结合本次请求生成完成证据，再发布 `done` 与 `result_id`。后继加工可以消费“同一工件所在工装已到站”的有效证据，机械臂的启动信号仍由其网关按本次请求写入。

## 1. 一条行为怎么定义

行为描述一台设备**接到有效请求时，自己能做什么，以及能对外证明什么**。以带件输送到指定位置为例，输送带只要求指定物料在其有效支承面上、目标可解、输送路径允许。至于物料是人放的、机械臂放的，还是本来就在带上，属于本次工艺的初始状态与编排。

| 契约内容 | 通用规则 |
| --- | --- |
| 参数和角色 | 动作接受类型化参数和角色，例如物料 `M`、源端点 `S`、目标端点 `D`、目标位姿、配方。定义写角色，场景绑定实例。 |
| 前置条件 | 写成对当前信号的判定，分清设备自身状态与所需外部事实。例如“夹具空”“指定物料在源端受支承”“目标可接收”。需要独占的资源在提交前原子取得并核对。 |
| 持续条件 | 只在相应阶段检查必须保持的条件。例如抓住工件后检查抓持约束，放置后检查目标支承；“夹具空”只用于开始抓取。 |
| 完成条件与对外结果 | 有限动作依据实际到位、归属、支承、工艺记录等形成与本次请求关联的完成证据。契约列出可供后续读取的结果。持续驱动和发布状态用实时电平或逐件事件表示，终止与停稳由相应控制动作确认。 |
| 信号与实现 | 每个条件叶子必须能绑定到实际设备端口、参数比较、物理观测、授权或请求账本。只有绑定成功且采样有效的能力才可执行。动作接收命令，完成时发布证据，并由网关投影为 `done`、`result_id` 等协议反馈。 |

### 条件用哪些信号

下文带参数的英文名是**拟议的条件谓词和回执**，表达行为需要／提供的事实。其参数通过工艺上下文关联。只有显式投影为设备信号的量才占用已声明的标量端口，其余由参数、观测、请求或授权提供者取值。逻辑信号可以由多个物理观测计算。信号由各自的权威来源写入，编排器只读取、关联或路由。逻辑信号的声明包含角色参数、值类型、单位／参考系、生产者、采样时刻、有效期和关联范围。端口按 `instance_id/port_id` 解析，观测按已登记的提供者取值；事件另带序号或版本。条件的真假与信号有效性分开，过期、缺失或主体不匹配时结果为未知。

| 逻辑信号或判定 | 含义、类型与来源 |
| --- | --- |
| `Ready(A)`、`Empty(A)` | 设备 A 可接相应类别请求，以及夹具或搬运手当前空闲。按型号从使能、忙、故障、当前任务及真实抓持约束取值，如 `enableTag`、`busy`、`error`、`holding_material`。停止、保持、恢复及查询各用自己的准入规则。 |
| `At(M,E)`、`SupportedAt(M,E)` | 布尔状态。按物料身份和端点检测区评估实际位置；支承还要求相应支承面的实际接触或契约允许的承载约束。输送出口的 `part_ready` 可发布就绪状态；带具体工件的连接还需从区域观测解析其身份。 |
| `HeldBy(M,A)`、`RetainedAt(M,E)` | 布尔状态。前者由工具与该件的抓持约束产生，后者由工装、槽位或平台的固定／承载关系产生。查明实际持有者，单独的 `occupied` 或 `holding_material` 只说明有件。 |
| `CanReceive(D,M)`、`Reachable(A,E)`、`ZoneClear(Z)` | 接收端依据容量、尺寸、载荷、占用和接口角色判断可接；运动规划器依据坐标、行程、关节限位与适用的路径检查判断可达；共享区域状态由现场观测与已声明的区域规则判定。 |
| `Reserved(R,owner)` | 由库存或资源服务确认资源 R 的预留持有人及令牌。资源目前空闲是预留调用的输入，持有有效预留是预留成功的结果。 |
| `Measured(A)`、`AtTarget(A,T)`、`Stopped(A)` | 数值采样和布尔判定。使用设备自己的反馈，如 `actual_speed`、`actual_position`、`actual_height`、`actual_angle`、TCP 位姿、关节角及速度。绑定目标 T 的单位、参考系、容差和所需连续采样数。 |
| `Aligned(tool,port,M)` | 根据工具实测位姿和物料上具名端口的当前位姿，比较位置与适用的轴向／姿态误差。端口角色兼容是准备检查，实时对准是执行证据。 |
| `Transferred(M,S,D,transfer)`、`Processed(M,operation,recipe,job)` | 带身份的事件或登记记录。前者由交接服务在源释放、接收方实收后提交，后者由工艺执行器在有效加工条件保持了约定周期后提交。携带运行代次、来源动作请求、物料和相应的端点或工单。 |
| `Accepted(request)`、`Succeeded(request)` | 来自调度请求账本和相关回执。网关核对运行代次、设备、激活及请求号。成功回执与物理完成条件共同决定工步完成。 |

**模板中的落点。** 行为仍通过 `condition_contract.preconditions`、`sustaining_conditions` 与 `completion_contract.checks` 引用登记项。现有 `runtime_contract.condition_model` 负责读取可用的类型化绑定。拟增加的语义描述随条件／观测定义登记，写明“本行为需要／可提供哪一事实、角色从何处取值”。每个可对外提供的完成事实必须能指回相应的实测检查或回执。DSL 工步不填写另一个设备的前置条件，也不在空间接口上附加控制信号。

### 各类型如何把判据绑定到端口或观测

下表是**条件取证示例**。对外发布的信号须先按本文“信号契约与按能力裁剪”选型并登记。端口读取带实例身份和质量。物理或服务观测可以补充判定，或由指定发布者投影为输出；已启用能力规定的外部信号须独立通过 I/O 与时序验收。

| 设备 | 可绑定的设备级信号示例 | 条件的具体取值方式 |
| --- | --- | --- |
| 机械臂 | `enableTag`、`busy`、`error`、`holding_material` | 接单用使能和无忙无故障；空手／持指定件查抓具状态与约束双方 ID；末端到位查实测 TCP 与关节速度。工具加工还读取工具与物料端口的距离和夹角。 |
| 传送带 | `actual_speed`、`runningTag`、`encoderTag`、`part_ready`、`blocked`、`capacity_available` | 到位取指定件的位置、支承及目标区域，停稳取实速与容差；编码器提供相对行程。下游实际接收由交接记录提供。 |
| 旋转台 | `actual_angle`、`rotating`、`at_station`、`occupied` | 到角与停稳用同一转子的角度和角速度；带载保持用工装约束的工件 ID；共享区清空从已绑定区域读取。 |
| 机床 | `busy`、`error`、`result_id` | 就绪还需工位支承及物料状态。加工完成绑定同件同工艺的操作记录与结果状态；`execute` 是命令输入。 |
| 出料口 | `countTag`、`buffer_count`、`material_available`、`empty` | 生成完成绑定有限库存中的新增身份；呈送完成绑定该件在出口可取。数量与可用位只作状态投影。 |
| 物料（含托盘） | 按能力选用 `picked`、`carried`、`placed`、`holder_id`、`location_id`；历史承载观测有 `slot_available`、`load_count` | 绑定物料刚体、接触、约束或槽位台账。观察值和请求绑定到同一实例；承载运行态在真实装卸确认后更新。 |
| 滑轨 | `actual_position`、`actual_speed` | 对位比较实际轴坐标与解析后的目标，检查速度阈值；命令中的具名端点或米制数值仅提供设定值。 |
| 升降台 | `actual_height`、`moving`、`at_level`、选配 `transfer_ready` | 升降到位核对高度和实速；已接／已放取指定物料的目标支承及归属记录。辅助链高低位须有对应位置观测。 |
| 仓储柜 | `cell_available`、`reservation_granted`、`reservation_id`、`cell_full`、`stored`、`released` | 绑定具体格位和所有者的台账版本；实际存取还需该件的物理交接回执。 |
| 人物 | `busy`、`error`、`holding_material` | 吸附与解除读取手部约束和物料身份；撤离读取人物或手端实测位置；放置完成结合目标支承与本次交接记录。 |

## 2. 十类设备的通用行为

按类型直接查 **条件 → 数据来源 → 比较值 → 完成证据**：[机械臂](#bind-robot-arm)、[传送带](#bind-conveyor)、[旋转台](#bind-rotary-table)、[加工机床](#bind-machine-tool)、[出料口](#bind-material-source-station)、[物料](#bind-workpiece)、[滑轨](#bind-linear-rail)、[升降台](#bind-lift-table)、[仓储柜](#bind-storage-rack)、[搬运人员](#bind-human-operator)。

**同名的条件、端口和观测怎样对应？** 每个设备的表格先用“行为说明”说明动作的对象和用途，再列出前置与完成条件的具体绑定。绑定表里的“入／出”均从设备视角读，`= false`、`≤` 等是要计算的判据。一项条件可以同时读多个来源。端口的方向／PLC 类型见上文端口表；物理观测、参数、授权和请求账本在表内点名。采用公共有限动作协议时，结果用同一次请求的 `done`、`result_id` 发布。持续动作看实时反馈，被动动作看外部交接证据。仅作为目标或参考模板的绑定要在准备时找到提供者才可启用。

以当前从空夹具取件的机械臂 `pick_and_place` 入口为例，可以从契约一直追到实值。下面列出三个条件叶子，单个叶子满足仅证明其所代表的子条件。

| 行为阶段／条件 | 契约里怎样绑定 | 求值时读什么 |
| --- | --- | --- |
| 前置 `pick_and_place.pre_1` 中的“机械臂未忙” | `not ref(pick_and_place.busy_run)` → `kind=signal, device=self, port=busy, scope=run` | 当前运行该机械臂的**输出** `busy: BOOL = false`，且质量为 good。此条件还合取无故障、夹具空、来源可抓和目的地可接等叶子。 |
| 完成 `pick_and_place.completion` 中的“夹具已空” | `not ref(pick_and_place.holding_material_request_subject)` → `kind=signal, port=holding_material, scope=request_subject` | **输出** `holding_material: BOOL = false`，并核对本轮、激活、请求和物料身份。 |
| 同一完成条件中的“已经放好”与“执行器确认成功” | `ref(pick_and_place.placement_confirmed)` → 已登记的放置观测；`ref(pick_and_place.matching_success)` → 本次请求账本 | 物理放置观测为 true，并且同一请求已接受且成功。与上一行合取后，调度器才能完成该工步。 |

模板的查找顺序为 **行为阶段的 `source/key` → 同名条件定义的 `expression_ref` → 表达式叶子的 `binding` → 实例端口或指定提供者**。例如上表第一行最终定位到场景信号表的 `<scene>/<instance>/busy`。原生条件（`opaque`）按注册的条件键调用专用判定，相关章节列明该判定实际读取哪些字段。`signal_refs` 是相关端口清单，单凭清单无法推出与／或、取反和请求范围。这些写法是对现有 `ac-condition/0.1` 的阅读说明。[抓放契约](../../public/scene/S01/contracts/robot_arm.json) · [表达式与绑定类型](../../src/contracts/condition-expression.ts) · [场景绑定读取器](../../src/runtime/assembly/SceneConditionBindings.ts)

<a id="bind-robot-arm"></a>

### 机械臂 `robot_arm`

**通用行为及条件绑定**

下表采用拟议设备库的通用名称。现行独立命令和整场景入口的支持范围仍按已验证的型号配置选择。“入／出”为设备端口，BOOL 判断写出电平值。场景观测以样本键加字段表示（例如 `R/robot_state.qdot`），`r` 为本次请求。表内的“成功回执”均由请求账本核对本轮、激活、设备和请求号；顶层有限任务另发布 **出** `done: BOOL`、`result_id: DINT`。内部步骤的结束用于推进原任务。

| 行为 | 行为说明 | 前置条件 → 输入、反馈或观测判定 | 完成条件 → 证据或信号值 |
| --- | --- | --- | --- |
| `move_to_pose` | 把工具中心点移到指定位置和姿态。回位时，目标取自该机械臂绑定的初始姿态。 | `move_to_pose.pre_1` 读 **出** `busy == false AND error == false`，且 `pose_plan_valid == true`：工具刚体未持件，目标位姿通过规划预检。普通位置目标由 IK 收敛判定，配置的归位目标校核 GLB 零位。 | `move_to_pose.completion` 读成功回执，`R/robot_state.targetError ≤ ik_position_tolerance_m`、各 `abs(qdot) ≤ settle_speed_rad_s`、`orientationSatisfied == true`。S04 仅接受归位目标，其原生判定读取 `handoff/state.arms[R].atHome`。 |
| `move_joints` | 把六个关节分别转到指定角度，让各轴同步到达目标关节配置。 | **入** `enableTag == true`；载荷 `steps[].q` 为六个有限关节目标且在各自限位内，接单校验实例、请求号、空闲和无故障。 | 轨迹结束且各关节角误差的最大值 ≤ 该执行器容差、各 `abs(qdot) ≤ settleSpeed`。关节值和速度来自运行状态，单步结束由任务执行器确认。 |
| `grip` | 用夹具抓住指定工件，建立工件随工具一起运动的持有关系。 | **入** `enableTag == true`；运行观测 `tool_empty == true`、`material_in_capture == true`、`payload_compatible == true`，核对本件身份、来源授权与相对速度上限。 | 物理抓持约束实际存在且挂接本件，产生 `grip.succeeded` 步骤观测；**出** `holding_material == true`。手动夹具模式另可使用 `gripperTag` 作命令。 |
| `release` | 解除夹具对当前工件的持有。UR10 的物理放置模式还会等工件在目标支承面放稳。 | **入** `enableTag == true`；观测 `holdingMaterialId == M`、`release_pose_valid == true`，且会话已选目标支承（`target_reserved`）。 | 夹持约束解除、`GraspService.placed() == true`，即目标支承、落点与速度等条件成立，输出 `holding_material == false`。只允许自由释放的型号可单独声明解除约束证据。 |
| `pick_and_place` | 将指定工件移至目标并完成交付。完整取放从空手取件开始，持件续行从搬运与放置阶段开始。抓取口、目标类型和放置姿态由型号与本次任务绑定。 | 完整取放沿用现有 `pick_and_place.pre_1`：出 `busy/error/holding_material` 均为 false，`source_pickable`、`target_admissible` 成立。迁移后的持件续行要求显式选定该起点，夹具约束的持有者、工件 ID 和抓取口均与本次请求匹配。持有其他工件或缺少有效约束时拒绝。 | 目标为支承面时，核对同件在目标实际放稳、本臂已松手及本次成功回执；已有抓放入口读取 `holding_material == false`、`placementConfirmed == true`。目标为另一夹具时，核对同件约束已移交、供方空手及匹配的双臂交接回执。要求退位时再核验该终态。 |
| `process_material` | 用装在机械臂上的工具对准工件加工口，执行要求的工艺并退位。例如 S11 用焊枪尖对准焊接点并保持规定时长。 | `process_material.ready` 从 `indexing/state` 读 `active == tableMaterial == M`、人已退位、台已在加工角停稳、未有该件加工记录。工件已固定，载荷指定的工具与工件加工口匹配，资源获准后写 **入** `start_process=true`、`request_id`。 | 在加工阶段以实测枪尖 `positionError ≤ process_position_tolerance_m`、`angleErrorDeg ≤ process_angle_tolerance_deg` 且工具静止累计有效时长。退回后 `process_material.completion` 读 `robotHome == true`、匹配本件和请求的 `operations` 记录以及成功回执。 |
| `wait_time` | 让当前任务在本步骤等待指定的有效仿真时长，然后继续下一步。 | 等待时长有效，入 `enableTag == true`，开始累计该步骤的仿真时间。 | 本步骤有效累计时间达到指定秒数，推进原任务。 |
| `wait_signal` | 让当前任务停在本步骤，直到所选输入达到期望值；超过约定等待时限时报告超时。 | 等待时限有效。入 `enableTag == true`，选定一个可读的入 `in1Tag` 至 `in4Tag` 并给出期望 BOOL。 | `signals.peek(portId) == expected` 时推进步骤；超过步骤时限报告失败。 |
| `set_output` | 在任务运行到本步骤时，将选定的工艺输出写为指定布尔值，供外部设备读取。 | **入** `enableTag == true`；载荷选定一个可写 **出** `out1Tag` 至 `out4Tag` 和合法 BOOL。 | 当前仿真步成功提交 `outNTag = requestedValue` 后推进步骤。 |
| `pause_pick_intake` | 关闭新抓取任务的接单入口，在途任务按原阶段继续。 | UR10 接单许可输入 `pause_pick == true`。 | 暂停锁存生效，新抓取请求被拒绝；当前运动仍按原任务推进。 |
| `resume_pick_intake` | 重新开放抓取接单入口，后续新请求可以按正常条件申请执行。 | UR10 撤销入 `pause_pick`，或通过支持的兼容入口 `resume_pick` 清除同一锁存。 | 读到 `pause_pick == false`，重新接受符合条件的新抓取请求。 |
| `hold_motion` | 让正在运动的机械臂减速停稳，保留当前任务、阶段和持件关系。 | 入 `enableTag == false`，使在途任务进入减速保持。 | `holding == true` 且各关节 `abs(qdot) ≤ settleSpeed`。holding 指运动保持；持件反馈为 `holding_material`。 |
| `resume_motion` | 让已保持的机械臂从当前关节状态继续执行同一任务的剩余步骤。 | 入 `enableTag == true`，原任务与步骤仍有效。 | 保持状态 `holding == false` 且 `enableTag == true`，继续执行保留的阶段。 |
| `publish_robot_state` | 持续发布机械臂当前任务、关节、夹持与故障状态，供监视和工艺判断读取。 | 本实例状态、信号表及任务账本可读。 | 将实际抓持、当前请求和故障状态投影到 **出** `holding_material`、`accepted/busy/done/result_id/error/error_code` 及阶段输出。不为发布动作生成单次完成。 |

**抓放的已用入口与迁移方式**

抓瓶头或瓶尾决定工具对接工件的哪个位置。抓放从哪一步开始，由该工件此刻的真实持有者和本次请求共同决定。在 S04，R1 从输送带抓瓶头；双方对准后，交接服务把同一瓶子的抓持约束转给抓瓶尾的 R2。随后 R2 已经持瓶，直接将瓶子按目标姿态放到出口带。两段任务保留各自的请求身份和完成证据。

统一行为脚本时，这两个旧 ID 分别映射到抓放流程中的“抓取并向接方交付”和“从已持件开始放置”。下表保留当前执行契约。现行单设备命令校验仍要求完整的 `pick_and_place` 依次包含抓取和释放，持件续行是后续迁移设计。

| 抓放兼容入口 | 行为说明 | 原前置条件绑定 | 原完成条件绑定 |
| --- | --- | --- | --- |
| `pick_and_handoff` | 由供方机械臂抓起工件并送到交接位，两臂对准各自的抓取口后，将同一件工件的持有关系移交给接方。 | `pick_and_handoff.ready` 读 `handoff/state.active == M`、`pickReady == true`、双方 `arms[臂].atHome && !held`，**出** 入口带 `abs(actual_speed) ≤ 0.02 m/s`。授权要求本次取得两台机械臂、入口带和工件资源。 | `pick_and_handoff.complete` 读成功回执，`arms[接方].held == M`、供方空手、`transfers` 有同件供方到接方的移交记录。 |
| `place_held_material` | 从接方已经持件的状态开始，将手中的工件按指定朝向放到目标支承面并松手。 | `place_held_material.ready` 读接方 `held == M && stopped`、供方退回且空手、**出** 出口带 `abs(actual_speed) ≤ 0.02 m/s`，当前主体匹配。 | `place_held_material.complete` 读成功回执、接方空手、`handoff/state.onOutfeed == true` 且 `placed` 记录含 M；落带时核对本件倒置姿态与支承。 |

**单台机械臂任务入口**

`execute_job` 提交一份有序步骤清单，由一台机械臂在一个请求号下执行。典型用途是把移动、等待设备就绪和写工艺输出组合成一个设备任务；跨设备的顺序由场景 DSL 编排。直接提交抓放任务时可走 `pick_and_place`，两种入口均只接受一次顶层请求。

| 任务入口 | 行为说明 | 接受条件 | 完成条件 |
| --- | --- | --- | --- |
| `execute_job` | 按载荷给出的顺序执行一组机械臂步骤，所有步骤归属同一个顶层请求。 | **入** `enableTag == true`、无故障、账本无忙请求，步骤载荷通过校验和规划。含抓取的任务还查 `pause_pick != true`。网关提交 `start_pick`、`request_id`。 | `RobotJobRunner.finished == true` 且相应账本请求成功，运行观测 `execute_job.succeeded == true`，投影该请求的 `done/result_id`。 |

现有测试示例：等待 `in1Tag == true`（超时 1 仿真秒），随后写 `out1Tag = true`，再等待 0.03 仿真秒。三步执行完毕，才回报这一个请求成功。当前十二个发布场景的 DSL 都没有直接调用此入口。[命令载荷](../../src/contracts/robot-command.ts) · [实际执行用例](../../tests/robot-runtime.test.ts)

[抓放条件绑定](../../src/runtime/assembly/SceneConditionBindings.ts) · [双臂交接](../../src/runtime/assembly/HandoffRuntimeAssembler.ts) · [加工条件](../../src/runtime/assembly/IndexedProcessingRuntimeAssembler.ts) · [UR10 信号与状态](../../src/runtime/programs/RobotProgram.ts) · [机械臂步骤执行](../../src/devices/robot_arm/behavior.ts)

<details>
<summary>通用行为语义与兼容入口</summary>

| 通用行为及已有入口 | 固有前置条件与信号 | 完成条件及可输出的证据 |
| --- | --- | --- |
| 定位或回位：`move_to_pose`、`move_joints` | `Ready(臂)`，目标坐标或关节角有效、可达、行程合法；带件时核对载荷。回位以配置的静止姿态为目标。 | 位姿目标按 TCP 位置及指定的朝向核验，关节目标按各关节角核验，再检查关节速度。产生 `AtTarget(臂,T)`、`Stopped(臂)`。 |
| 抓取：`grip` | `Empty(臂)`、指定件可接管，抓取接口兼容且达到捕获距离、相对速度及载荷要求。可用 `gripperTag` 请求夹持。 | 指定工具与同件实际建立约束，产生 `HeldBy(M,臂)`，同步 `holding_material`。 |
| 夹具释放：`release` | 本臂实际持有指定件；约定稳定放置时检查目标和支承。 | 确认原夹持解除，物理放置模式另需确认同件在目标放稳。 |
| 通用抓放：`pick_and_place` | 按请求绑定的起始状态检查空夹具与可取来源，或检查本臂确实持有同一工件。按目标类型核验支承面或接方夹具。 | 分别以同件稳定放置或接方实收为终点；持件续行复用搬运和放置阶段。 |
| 工具加工：`process_material` | 指定工件在工位稳定且满足工艺所需固定方式；工具、物料端口与配方匹配，目标可达，作业区许可。对准是进入加工阶段的门槛。 | 在 `Aligned(tool,port,M)` 和工艺互锁持续有效期间累计周期，得到 `Processed(M,…)`；约定退位时还需 `AtTarget(臂,退位点)`。工艺可保留工件外形。 |
| 执行程序和内部步骤：`execute_job`、`wait_time`、`wait_signal`、`set_output` | 程序和参数合法，接单时设备就绪。等待时长有效；等待端口可读且类型匹配；输出端口可写且写入权归当前执行器。 | 程序的所有必需步骤和终态均确认。等待时长按有效仿真时间，等待信号按新鲜采样与期望值，写输出按已提交的对应端口值。保留独立命令网关与任务步骤的调用边界。 |
| 接单许可与运动保持：`pause_pick_intake`、`resume_pick_intake`、`hold_motion`、`resume_motion`、`publish_robot_state` | 按控制意图核对接单开关或当前运动／保持任务及使能条件；状态发布读取当前设备快照。 | 暂停／恢复接单以接单状态为证。保持以减速停稳和保留原任务为证，恢复以同一任务继续原阶段为证。状态发布持续输出关节、夹持和任务反馈。 |

</details>

<a id="bind-conveyor"></a>

### 传送带 `conveyor`

**逐条件绑定（传送带）。** 下表中的 `transport` 表示物理观测流 `<输送实例>/transport`，`drive_state` 表示同设备的驱动组观测。比较前核对运行、请求、主体 M 和目标。分区、定距、反转及节拍行是规范定义的可选能力，须由所选型号提供对应的观测和驱动。

| 行为 | 行为说明 | 前置条件 ← 读取与比较 | 完成条件／持续反馈 ← 读取与比较 |
| --- | --- | --- | --- |
| `transport_to_position` | 将指定物料或托盘运到一个具名目标点并停稳，供设备在该位置取料或作业。 | 配置 `transport_mode == continuous`，世界观测中 M 活跃、已受支承且静止，目标可解、路径及运动区可用；授权读取本请求的驱动组和 M 的资源归属。 | `transport.subject == M`、`transport.target == 请求目标`、`distance ≤ positionTolerance`、`supported == true`、`stationary == true` 连续满足 `settleTicks`。驱动据此返回成功，调度器再核对本次请求的匹配回执。 |
| `transport_to_exit` | 把指定物料送入本带出口交接区，使其可供取走。接收方真正收件由交付行为确认。 | 观测同件已接入本带、出口路径可走、所经区可放行。 | M 的参考点进入已配置出口检测区且仍受支承，输出 `part_ready == true`。使用定位适配器的型号另核对出口距离及停稳观测。 |
| `move_by_distance` | 以本次启动位置为基准，按指定相对距离输送载荷并制停，核对带面行程与工件实际移动。 | 选配定距驱动与载荷位置观测齐备；`target_distance`（输入，m）和速度设定有效，记录本次 `encoderTag` 起值与 M 起姿。 | 带面有符号累计行程增量达到设定、`abs(actual_speed) ≤ 停稳阈值`，同时实测 M 在预期目标容差内且受支承。 |
| `accept_material` | 在输送带入口接收指定工件，确认它已进入支承区域并登记本带占用。 | `capacity_available == true`，入口检测可接 M，交接服务核实来源持有该件、资源获准。 | 入口检测区实测主体为 M，支承及接管成立，占用／归属登记已提交。 |
| `release_material` | 将出口处已到位的工件交给指定接收方，在接收方实收后释放本带占用。 | M 实际在出口且接收方可接，检查接收方容量／预留与 `release_gap_s`。使用末段放行许可的型号在交接期间读 `release_waiting_material == true`。若该位由本次提交写入，授权阶段先取资源与环境许可。 | 接收服务返回匹配 M 的交付记录，源端观测确认该件已离开并释放占用。按物料请求返回成功。 |
| `start_conveying` | 按当前许可和速度设定连续驱动带面；空带也可以运行。 | `runTag == true`、已选速度输入有效；分区模式另读对应分区许可。 | 持续发布 `actual_speed` 与 `runningTag`，后者取实际带速超过静止阈值。允许空带运行。 |
| `set_speed` | 在允许运行的模式下调整带面速度，按设备的加减速能力过渡到新设定。 | `speedTag`（或已选英制输入换算值）为有限有效设定，限定唯一写入者及合法模式。 | `abs(actual_speed − 本次目标速度) ≤ 到速容差`。 |
| `reverse_conveying` | 让支持反转的输送带先减速至零，再按相反方向启动并达到指定反向速度。 | 配置 `allow_reverse == true`，反向路径及分区策略有效，本次冻结反向设定速度。 | 实速采样先经过零速容差，再达到反向目标速度容差；保留本次动作的过零记录。 |
| `stop_conveying` | 将带面目标速度降为零并确认实际停稳，保留带上物料的位置与归属。 | 读 `drive_state.maxSpeed`；已静止，或减速配置有效且物料可追踪，就可受理制停。停止指令按模式取 `runTag == false` 或零速度设定。 | 驱动组最大实速≤速度容差，实际已停稳、在带件仍可追踪。定位驱动还核对活动主体速度。 |
| `advance_to_next_stop_point` | 在分区输送模式下，将当前区的工件推进到下一检测区，并随检测结果更新两个区的占用。 | 分区启用，`stop_point_occupied_i == true`，下一区可接收且驱动获准。 | 持续跟踪同件进入下一检测区，更新两区的 `stop_point_occupied_i`；按型号可产生带身份的释放通知。 |
| `zone_accumulation` | 分别控制各区的启停；下一区暂时无法接收时，让当前有件区等待，空间释放后再推进。 | 已配置独立驱动与区段检测。每步读本区／下一区占用、下一区运行状态和下游许可。 | 持续驱动：下一已占用区停机时，当前有件区停止，报告 `blocked`；检测变化后重算速度与 `capacity_available`。 |
| `meter_release` | 按规定的最小放行间隔逐件允许工件离开末区，控制出料节奏。 | 出口检测到该件、`release_waiting_material == true`；首件或距上次实际放行的仿真时间≥`release_gap_s`。 | 持续门控；每件通过检测点只记录一次实际放行并更新计时，最终接收由交接回执确认。 |
| `publish_drive_feedback` | 按仿真步发布带面实速、运行状态和检测区状态，配置编码器时还发布行程或脉冲。 | 每步读取已配置的带面速度、支承及检测区观测。 | 持续输出 `actual_speed`、`runningTag`、`part_ready` 等有效采样；启用编码器时按实际速度与步长累计 `encoderTag`。 |

[输送适配器与到位判定](../../src/devices/conveyor/behavior.ts) · [条件键与实际观测](../../src/runtime/assembly/SceneConditionBindings.ts) · [输送带契约](../../../test1/docs/schema.md)

<details>
<summary>通用行为语义与兼容入口</summary>

| 通用行为及已有入口 | 固有前置条件与信号 | 完成条件及可输出的证据 |
| --- | --- | --- |
| 定目标输送：`transport_to_position`、`transport_to_exit`、`move_by_distance` | `Ready(带)`、`SupportedAt(M,本带或允许的准入支承)`，目标点、出口区或相对行程可解析，方向合法、路径可通过。 | 定点核对同件位置误差、支承及约定停稳；到出口核验 `At(M,出口)`、出口支承及型号的停带规则；相对行程还需核对 `encoderTag` 的行程增量和载荷实测位置。可发布 `part_ready`。到达出口本身只提供到位证据。 |
| 接入／交付：`accept_material`、`release_material` | 接入要求入口可用、来源有指定件及交接许可；交付要求同件在出口、接收端 `CanReceive(D,M)`、必要的节拍间隔及资源授权。 | 接入以同件进入入口、受支承、登记占用为证；交付以接方实收、源占用释放为证，提交一次 `Transferred`。 |
| 驱动与速度：`start_conveying`、`set_speed`、`reverse_conveying`、`stop_conveying` | 启动／调速核对驱动就绪、方向和速度范围；反转需已启用反转能力。停止允许对已静止设备幂等确认。输入按型号取 `runTag`、`speedTag`。 | 启动为持续驱动；调速以 `actual_speed` 进入新设定容差为证；反向到速还须有过零过程；停止以实测速度进入静止阈值为证。 |
| 分区与节拍：`advance_to_next_stop_point`、`zone_accumulation`、`meter_release`、`publish_drive_feedback` | 适用模式启用，各区占用、下一区可用性及节拍依据有效；反馈读取驱动和检测区快照。 | 持续动作分别输出同件进入下一检测区、各区占用／`blocked`、单件放行和间隔记录、以及实际带速与行程。最终交付按交接行为取证。 |

</details>

<a id="bind-rotary-table"></a>

### 旋转台 `rotary_table`

**逐条件绑定（旋转台）。** `actual_angle` 为设备输出（REAL，°），`rotating`、`at_station`、`occupied` 为设备输出（BOOL）。S11 已接入带载分度，其余入口按启用的型号能力绑定。

| 行为 | 行为说明 | 前置条件 ← 读取与比较 | 完成条件／持续反馈 ← 读取与比较 |
| --- | --- | --- | --- |
| `rotate_to_station` | 让转台绕自身轴线分度到指定工位或角度，带载时工件随同一个工装转动。 | 角度模式取输入 `angleTag`，工位模式取 `target_station` 经工位表解析目标。轴停稳、目标有效、转动区安全许可成立。带载配置加读工装实测约束对应 M；S11 取 `indexing/state.tableMaterial == M`，并检查人员和机械臂撤离。启动由 `rotate_to_station`、`request_id` 提交。 | 以转子刚体求目标角误差≤`angle_tolerance_deg`，轨迹速度和刚体角速度（换算同单位）≤`settle_speed_deg_s`，带载约束持续有效。S11 连续两次到站采样，`rotations` 中本请求的 `measuredAngleDeg` 匹配目标，`stopped[台] == true`；对外投影 `actual_angle`、`at_station`、`rotating`。 |
| `accept_material` | 在已对位的台面接收一件工件，登记台面占用；需装夹的型号同时确认固定关系。 | `rotating == false`，实测台面和来源端点对齐，台面支承位空闲、容量及授权有效。 | 物理观测确认 M 在指定台面受支承、归属已接入，更新该区域 `occupied`。需夹持的型号另验同件约束。 |
| `release_material` | 从已对位的台面向接收方交出工件，确认交接后更新台面占用。 | `rotating == false`，出口对齐；本台实际持有 M、接收端可接且已获所需预留。 | 交接服务确认同一 M 在目标接收，原台面登记和占用随该次交接更新。 |
| `hold_rotation` | 在分度途中让转台减速并保持当前位置，保留工件和原定位任务。 | 启用在途保持，`enableTag` 按控制模式失能，现有载荷支承与任务资源仍有效。 | `rotating == false`、角速度进入静止阈值，原任务目标与持件保留。 |
| `resume_rotation` | 从保持位置继续原分度任务，沿原任务约定的方向转向保留的目标。 | `enableTag == true`，读取保留的任务与原目标，故障已解除且资源仍归该任务。 | 任务状态从保持回到原分度执行阶段。到站仍由定位动作的实测终点确认。 |
| `convey_on_deck` | 在转台停稳并对接后，驱动选配的台面输送机构，使工件沿台面进出。 | 台面输送模块启用，`rotating == false`、与接收端对齐，`transfer_enable == true` 且已选速度输入有效。 | 持续发布实际输送及占用状态。物料离台后由接收端确认 `release_material`。 |
| `publish_turntable_state` | 持续报告台面角度、是否转动、是否到站和交接区占用情况。 | 每步读取转子角度、角速度与支承区占用。 | 持续更新 `actual_angle`、`rotating`、`at_station`、`occupied`。空载定位允许时不要求 `occupied == true`。 |

[转台实测角度与制停](../../src/devices/rotary_table/behavior.ts) · [分度请求与回执](../../src/runtime/assembly/IndexedProcessingRuntimeAssembler.ts) · [其余转台型号声明](../../public/scene/S12/contracts/rotary_table.json)

<details>
<summary>通用行为语义与兼容入口</summary>

| 通用行为及已有入口 | 固有前置条件与信号 | 完成条件及可输出的证据 |
| --- | --- | --- |
| 分度定位：`rotate_to_station` | 目标角或工位可解析，转轴可启动、转动区清空，按装夹策略检查 `RetainedAt(M,工装)`。起点、终点和旋转方向随设备与请求绑定。 | `actual_angle` 的周期角误差合格、实际角速度达静止阈值，产生 `AtTarget(台,T)`、`Stopped(台)`。带载时同时复核该件仍固定。 |
| 台面交接：`accept_material`、`release_material` | 台面已在交接姿态且静止。接入需空位，释放需实际持有该件及下游可接。 | 同件进入并建立相应支承／固定，或目标接收并清除台面占用。分别输出 `SupportedAt`／`RetainedAt` 或 `Transferred`；`occupied` 为设备级反馈。 |
| 保持、恢复及持续功能：`hold_rotation`、`resume_rotation`、`convey_on_deck`、`publish_turntable_state` | 可控转动或同一已保持任务；台面输送还需对应机构和输送许可。 | 保持以实测停稳且目标保留为证，恢复以同一目标的分度继续为证。台面输送与状态发布持续报告占用、角度和运动状态。 |

</details>

<a id="bind-machine-tool"></a>

### 加工机床 `machine_tool`

| 行为 | 行为说明 | 前置条件概要 | 完成证据概要 |
| --- | --- | --- | --- |
| `machine_material` | 对已经放入机床加工点的指定工件执行一次加工周期，按工艺记录更新同一工件的加工状态。在 S06 中，这一步使毛坯变为成品。 | 机床可接单，同一毛坯已在加工点放稳，作业区及本请求所需资源可用。 | 本件有与本请求匹配的加工记录，达到工艺结果状态并保持支承。 |

**逐条件绑定（`machine_material`）**

通用模板的设备就绪项可绑定机床输出 `busy: BOOL == false` 与 `error: BOOL == false`，再合取工件与工位条件。S06 采用原生条件提供者，以下按其真实读取路径展开，表明每个端口是命令、反馈还是判断输入。设 `M` 为通过登记表解析的物料 ID，`r` 为当前请求，`w` 为本轮、质量为 `good` 的 `world/state` 观测，`m = w.machining`。写作 `m.workSupported` 的字段属于引擎观测；机床外部端口以“入／出”标明。

| 阶段／条件键 | 绑定到哪一项，怎样判真 |
| --- | --- |
| 提交前／设备可接单 | 驱动读取自身 `state != running`、未处于停止流程，核对请求的设备、运行代次及已登记行为；`busy`、`error` 是出 BOOL 状态反馈。当前 S06 的 `machine_material.ready` 取值见下三行。 |
| 前置／`machine_material.ready`：工位有本件毛坯 | **身份＋观测**：从请求参数 `subject_id` 查得 `M`；`m.machineItem == M` 且 `w.bodies[M + "/body"].materialState == "raw"`。 |
| 前置／同一 `ready`：稳定支承 | **物理观测**：`m.workSupported == true`。当前提供者实际检查刚体在场、无抓持约束、与机床支承面接触，中心位置误差 ≤ 0.025 m、转角误差 ≤ 0.07 rad、线速度 ≤ 0.04 m/s、角速度 ≤ 0.12 rad/s。这些数值是 S06 候选仿真的判据。 |
| 前置／同一 `ready`：作业互锁 | **区域与位置观测**：S06 绑定为 `w.robotClear[R] == true AND m.atStation == true`，即机器人空手退位、停稳且托盘停在加工站。其他型号的作业区许可需绑定各自的现场提供者。 |
| 授权／`machine_material.authorized` | **资源仲裁**：上列前置均真，且本次激活同时持有机床、物料、加工点、作业区关联机械臂的资源。 |
| 启动／命令网关 | **入** `execute: BOOL = true`、`request_id: DINT = Number(r.requestId)`、`subject_id: DINT = 工件 M 的登记号`。网关在前置与授权成立后提交并冻结本次参数。 |
| 持续／`machine_material.sustaining` | **每个有效物理步**：指定件、支承与作业区互锁持续成立，状态维持 `raw` 或已提交本请求的完成记录。机床驱动在加工期间逐步复核工件支承与退位条件，累计至 `ceil(cycle_time_s × 60)` 步才提交状态。 |
| 完成／`machine_material.completion` | **请求账本＋观测**：`requestState.outcome == "succeeded"`；`m.operations` 有 `material == M AND request == r.requestId` 的记录；本件 `materialState == "finished"`。同时保持同件在加工点、有效支承、区域清空及加工站到位。 |
| 结果／PLC 投影 | **出** `accepted`、`busy`、`done`、`error`（BOOL）和 `result_id`（DINT）。消费者只将本次成功回执、上行完成证据与匹配结果号合在一起解释为成功。停稳条件另读有效的 `busy == false`。 |

[机床条件提供者](../../src/runtime/assembly/LoadingRuntimeAssembler.ts) · [支承判据与容差](../../src/runtime/assembly/machiningDevices.ts) · [状态与加工记录](../../src/runtime/services/MachiningLineEnvironment.ts) · [命令端口及实际周期](../../src/devices/machine_tool/behavior.ts)

<details>
<summary>通用行为语义与兼容入口</summary>

| 通用行为 | 固有前置条件与信号 | 完成条件及可输出的证据 |
| --- | --- | --- |
| 工位加工：`machine_material` | `Ready(机床)`、`SupportedAt(M,加工点)`，指定件静止且处于工艺允许的输入状态，工艺区清空、机床与工件资源获准。需夹紧的型号再绑定夹紧观测。 | 支承和互锁在有效周期内保持，按同一物料、工艺和请求提交一次 `Processed`，实测输出状态与结果一致。单工序可绑定 raw → finished。加工期间取消保留最后确认的状态。 |

</details>

<a id="bind-material-source-station"></a>

### 出料口 `material_source_station`

**逐条件绑定（出料口）。** 表中的 `.pre_n`、`.completion` 均以本行行为 ID 为前缀。入／出指 PLC 方向，参数、仿真时钟、授权和库存台账是引擎数据源。下表给出模板应采用的绑定；现有有限批次环境已经能出具供料回执，六项独立生产动作仍按型号接入。

| 行为／触发 | 行为说明 | 前置条件 ← 读取数据及判定 | 完成或持续反馈 ← 实测依据；端口投影 |
| --- | --- | --- | --- |
| `produce_material` | 按一次生产请求或节拍生成一件指定型号的物料，为其分配运行身份并登记到缓冲库存。 | `.pre_1` ← 入 `runTag=TRUE`、未手动暂停，`product_spec` 已登记，台账的占用数＋预留数小于参数 `buffer_capacity`。按需模式 `.pre_2` 核对外部入 `produce_request=TRUE` 携带的新 `request_id`（PLC 主动请求入口）。若由 DSL 网关发命令，预检取待派发请求身份，网关在预检通过后写启动位；节拍模式 `.pre_3` ← 当前周期到期。两种触发按 `production_mode` 选择。 | `.completion` ← 本请求对应的新工件 ID 已实际入场且仅登记一次；出 `countTag` 对该次成功只加一，`buffer_count` 取实际在缓冲的数量。有限请求再投影 `done=TRUE`、`result_id=本请求号`。 |
| `present_material` | 将缓冲区中已有的一件物料送到出料口，使搬运设备能从该位置取走它。 | `.pre_1` ← 入 `runTag=TRUE`，台账包含指定件，出口检测区可用，交接授权有效；型号配置下游联锁时其许可必须为真。 | `.completion` ← 出口区域检测到本件且支承有效、允许取走；出 `material_available=TRUE`。该件被接走后重算出口占用。 |
| `pause_production` | 暂停生产周期和新件准入，保留已有库存、预留和已接受的任务。 | 入 `runTag=FALSE` 或收到授权的暂停命令。有无在途任务均可进入暂停；执行中停止新准入并保留已接受请求及预留。 | `.completion` ← 周期时钟已冻结且新生产请求关闭；本次暂停不增加 `countTag`，不清空 `buffer_count`。按请求模式仅回报暂停请求的结果。 |
| `resume_production` | 恢复暂停前的生产任务或节拍，从保留的生产进度继续。 | `.pre_1` ← 入 `runTag=TRUE`，手动暂停已解除，出 `error=FALSE` 或不存在阻止恢复的故障，原任务／模式及预留有效。 | `.completion` ← 原任务身份和剩余周期恢复推进；相同恢复请求不产生第二件物料。按请求模式回报恢复请求的结果。 |
| `schedule_production_cycle` | 在节拍模式下跟踪生产周期，到期时派发一次内部生产请求。 | `.pre_1` ← 参数 `production_mode=periodic`、`cycle_time_s>0` 且有限；`.pre_2` ← 随机策略配置了可复现随机源。入 `runTag` 控制周期推进。 | 持续机制：有效仿真时钟到期只派发一次内部生产请求；暂停冻结剩余时间。出 `countTag`、`buffer_count` 分别读取成功登记数和实际缓冲数。 |
| `publish_source_state` | 持续发布出料口的可取状态、缓冲数量及实际生产计数。 | `.pre_1` ← 本运行的供料记录、缓存和出口观测有效；无新增命令输入。 | 持续观测：`countTag=累计成功数`、`buffer_count=实际缓冲数`、`empty=当前无可取物料`、`material_available=出口存在可取物料`。已有任务的协议位从账本投影。 |

有限批次的实际证据示例为同一运行、主体的 `receipts[].kind == "supply_confirmed"`。它须在入场后经实际支承／停稳检查产生，`supply_requested` 仅表示请求。[出料口契约](../../public/scene/S01/contracts/material_source_station.json) · [供料确认实现](../../src/runtime/services/FiniteSceneEnvironment.ts)

<details>
<summary>通用行为语义与兼容入口</summary>

| 通用行为及已有入口 | 固有前置条件与信号 | 完成条件及可输出的证据 |
| --- | --- | --- |
| 生成与呈送：`produce_material`、`present_material` | 生成要求已登记物料型号、本次供料额度、可用缓冲及生产许可；呈送要求缓冲有目标物料、出口可用。 | 生成以唯一物料实际被接纳、缓冲与 `countTag` 更新一次为证；呈送以 `At(M,出口)`、可拾取及 `material_available` 为证。 |
| 生产节拍：`pause_production`、`resume_production`、`schedule_production_cycle`、`publish_source_state` | 控制当前周期或所保留的任务，读取缓冲、生产许可与实例时钟。 | 暂停冻结进度并保留存料；恢复继续原周期。调度和发布持续输出实际缓冲数、节拍或逐件接纳事件。现有环境供料可提供这些事实。 |

</details>

<a id="bind-workpiece"></a>

### 物料 `workpiece`（含托盘）

**逐条件绑定（物料）。** 被动响应没有物料侧命令输入。表内“归属”“约束”“支承”读取当前运行中同一工件的物理或交接记录。右列列出在启用相应观测的型号上向外发布的值。实体刚体可按物料 ID 查询记录。

| 被动响应／观测 | 行为说明 | 前置或触发 ← 读取数据及判定 | 成立或持续有效 ← 物理证据；物料输出 |
| --- | --- | --- | --- |
| `be_picked` | 记录这件物料已被外部抓具实际抓住，并登记当前持有者。 | 源工件已激活、可被该夹具接管，无冲突约束或预留。核对质量不超夹具载荷，捕获距离及相对速度在型号阈值以内。 | 本件与抓具的物理约束已建立；出 `picked=TRUE`（关联本次抓取的锁存通知）、`carried=TRUE`、`holder_id=抓具持有者的映射号`。 |
| `be_carried` | 在抓具或载具持续持有物料时，跟踪物料的随动位姿和持有者。 | 约束仍存在，约束双方与当前物料、持有者一致。 | 连续读取持件关系及相对位姿，发布 `carried=TRUE`、对应 `holder_id`，已确认区域变化时更新 `location_id`。 |
| `be_conveyed` | 跟踪物料受输送面接触驱动时的实际位置及所处区域。 | 本件刚体与指定输送面实际接触／受支承，且没有冲突的工具约束。 | 连续采样实际刚体位姿，区域服务确认后出 `location_id=登记区域号`；离开有效区域按型号标记未知。 |
| `be_placed` | 确认物料已放稳在目标支承上，更新它的已确认位置与放置状态。 | 同件与目标兼容、容量可用；核对目标区域、支承、速度与放置容差，要求堆放时检查参数 `can_stack`。 | 抓具解除，目标支承确定，放置判据成立；出 `placed=TRUE`、`location_id=目标映射号`。 |
| `be_released` | 记录原持有关系已经解除；此时物料可能仍在运动，放稳由放置观测另外确认。 | 触发方等于本件当前持有者，释放获准。定点放置另核对接收端，自由释放按其独立模式处理。 | 原持有约束解除；重新求 `carried` 和 `holder_id`（无持有者时为 `FALSE`、`0`）。自由释放后在落稳前保持 `placed=FALSE`；真实接收后再更新放置状态。 |
| `respond_to_physics` | 让物料刚体随物理步更新位姿和接触状态，反映重力、支承或约束的作用。 | 刚体处于激活状态，质量、形状、约束和本步物理采样有效。 | 每个物理步更新姿态、接触和支承，按已确认区域投影 `location_id`，无一次性结束位。 |
| `publish_material_state` | 汇总并发布物料是否被抓起、正被携带或已放置，以及持有者和区域身份。 | 读取同件同运行有效快照；区分抓取事件和当前持件状态。 | 按实际约束、稳定支承及区域登记发布 `picked`、`carried`、`placed`、`holder_id`、`location_id`，抓取通知采用确认锁存或关联记录。 |
| `observe_material` | 在旧编辑器预览中读取物料观测结果，供示意流程检查。 | 旧编辑器观测模板的前置列表为空，无输入端口。 | 旧预览读取 `observation.completed == true`，无独立输出端口；只用于预览验收。 |

**带承载属性的托盘。** 旧七个行为 ID 和一个示意观测均无托盘主动命令输入。服务调用通过 API 上下文传入托盘、槽位、工件及任务身份。S02 可从 `world/state.loading.slots` 读实际装载，S06 可从 `world/state.machining.slots` 读原槽与物料的对应关系；通用预留服务和 PLC 投影随型号接入。下列结果属于信号已配置时的约定。

| 旧入口 | 行为说明 | 前置或触发 ← 承载服务或物理数据 | 完成或持续反馈 ← 证据；承载属性输出 |
| --- | --- | --- | --- |
| `reserve_carrier_slot` | 为指定任务暂时占用一个可用槽位，给随后装载该工件留出位置。 | 槽位已登记，`slot_available=TRUE` 且剩余容量足够，物料兼容，调用携带有效任务身份；原子复核当前占用与预留。 | 台账出现本槽属于该任务的预留；重算 `slot_available`、`free_slots`，`load_count` 不变。 |
| `cancel_carrier_reservation` | 撤销本任务尚未落实的槽位预留，将可用容量还给其他装载任务。 | 台账所记预留属于本任务，本件尚未完成该槽装载。 | 本次预留已撤销，实际载荷仍保留；重算 `free_slots`、所查槽的 `slot_available`。 |
| `confirm_load` | 在工件实际落入指定槽位后，把该槽登记为已装载并更新盘上件数。 | 槽位空闲或已为本任务预留，尺寸／载荷满足，物料无归属冲突。 | 指定件实际落在该槽并确认承载，预留转为实际占用；`load_count` 对本件只增一次，`loaded=(load_count>0)`、`unloaded=(load_count==0)`。 |
| `carry_material` | 在托盘已承载工件时，维护该件与槽位的相对位置，使工件随盘移动。 | 台账确认本件归属该盘，或该型号选择的物理支承关系持续有效。 | 按载荷约束／支承持续核实工件与托盘的相对位姿，发布托盘的 `in_transport`、`holder_id`；各工件保持各自身份。 |
| `release_material` | 工件从盘上被接收方取走后，解除该槽的承载关系并更新装载数量。 | 槽位确有指定件，接收方、权限和交接端点有效。 | 接收方确认同件且旧槽已解除占用后，`load_count` 对本件减一次并重算 `free_slots`、`loaded`、`unloaded`。 |
| `be_transported_loaded` | 记录外部搬运设备正在运送整个已装载托盘，核对盘与已有载荷作为整体随动。 | 承载关系逐件有效，托盘与装载物总质量和外形满足外部搬运设备限制。 | 持续核对整盘和载荷同步移动，由外部执行器反馈运输进度；托盘发布 `in_transport` 和托盘持有者的 `holder_id`。 |
| `publish_carrier_state` | 发布托盘实际装载数、可用槽位、运输状态与持有者，供装卸任务读取。 | 当前盘的占用、有效预留、运输状态来自同一版本的台账／观测。 | `load_count=已确认件数`，`free_slots=扣除占用及有效预留的槽数`，`slot_available` 按所查槽位求值；同步 `loaded`、`unloaded`、`in_transport`、`holder_id`。 |
| `observe_slots` | 在旧编辑器预览中读取托盘槽位的观测结果。 | 旧编辑器观测模板的前置列表为空，无指令输入。 | 旧预览读取 `observation.completed == true`，无独立输出端口；实际工艺须读取上述槽位台账。 |

[抓取约束与放置确认](../../src/runtime/services/GraspService.ts) · [装载槽位快照](../../src/runtime/services/LoadingLineEnvironment.ts) · [加工托盘槽位与承载验证](../../src/runtime/services/MachiningLineEnvironment.ts) · [旧预览观测](../../src/domain/catalog.ts)

<details>
<summary>通用行为语义与兼容入口</summary>

| 被动响应或服务 | 固有触发／前置证据 | 可供其他行为消费的结果 |
| --- | --- | --- |
| 抓持、搬运与释放：`be_picked`、`be_carried`、`be_released`、`be_placed` | 实际抓持建立、保持、解除，或物料落到声明的接收支承。 | 分别发布同件 `HeldBy`、持件跟随、解除原持有关系、稳定 `SupportedAt(M,D)`。自由释放可以发生在空中，稳定放置要单独观测。 |
| 接触运输与观测：`be_conveyed`、`respond_to_physics`、`publish_material_state`、`observe_material` | 已登记的物料有有效物理采样或对应模式的预览观测。 | 对外提供位置、区域、支承和持有者快照。单件加工结果由加工执行方提交，物料保存该状态。 |
| 可选承载属性 | 预留读同一槽位的可用性、尺寸与权属；装载确认读实际落槽、同件支承及有效预留；卸载读接方实收。 | 预留和取消更新预留令牌。确认装载后更新占用与数量，随盘运动保持同件约束，卸出后释放槽位。占用和运输状态由载荷台账发布。托盘没有主动动作。 |

旧托盘的 `reserve_carrier_slot`、`cancel_carrier_reservation`、`confirm_load` 对应预留、取消和装载确认；`carry_material`、`release_material`、`be_transported_loaded` 对应被动随动、卸载和整盘运输；`publish_carrier_state`、`observe_slots` 对应状态查询或观测。物料和载具原有的触发、返回值和执行范围按相应旧型号契约保留，托盘状态端口按 schema.md 第八类映射到承载属性。

</details>

<a id="bind-linear-rail"></a>

### 滑轨 `linear_rail`

**逐条件绑定（滑轨）。** S07 设备输出 `actual_position`（REAL，m）和 `actual_speed`（REAL，m/s）。通用型号以标定容差为准；以下数值是当前 S07 装配实现。位置读数取立柱相对初始位置在轨道轴上的投影，另以 Jolt 刚体速度核对停稳。

| 行为 | 行为说明 | 前置条件 ← 读取与比较 | 完成条件 ← 读取与比较 |
| --- | --- | --- | --- |
| `move_to_location` | 从目标工位或货架格位求出轨道轴坐标，把滑座及其搭载设备移动到对接位置。 | `stopped[轨] == true`、挂载轴组停稳且无在途转移；从请求 `target` 的端点或格位通过 `resolveDock(...).rail` 求目标轴坐标，核对行程和带载扫掠路径。 | 轴轨迹已收敛、`abs(actual_position − 解算目标) < 0.005 m` 且立柱实测速率 < 0.01 m/s；本请求返回成功。 |
| `move_to_position` | 直接按给定的米制轴坐标移动滑座及其搭载设备。 | 轴组停稳；S07 适配器取请求参数 `position_m.value`、单位 m，检查有限、限位和带载路径。设备契约另有 PLC 目标口 `target_position`，映射由输入模式选定。 | 同一到位判定，比较对象为冻结的数值目标。 |
| `stop_motion` | 使轨道受控制动并确认滑座静止，同时保持既有载荷关系。 | 校验目标设备及制停能力，速度可读。S07 独立停止动作的预检要求装配停稳；运行中取消走驱动 `requestStop()` 的制动路径。 | 读取轨迹 `settled`：轴速度绝对值 < 0.001 m/s 且已制停或剩余误差 < 0.001 m。保持既有载荷归属；停止回执只关联本次停止。 |

S07 驱动使用 `execute`、`request_id` 的请求握手；`actual_position`、`actual_speed` 是设备级输出。授权阶段由资源仲裁器复核当前请求持有的运动资源。[轨道适配器](../../src/devices/linear_rail/behavior.ts) · [轴位姿与阈值](../../src/runtime/services/DeviceMountService.ts) · [仓储条件提供者](../../src/runtime/assembly/WarehouseRuntimeAssembler.ts)

<details>
<summary>通用行为语义与兼容入口</summary>

| 通用行为及已有入口 | 固有前置条件与信号 | 完成条件及可输出的证据 |
| --- | --- | --- |
| 轴定位：`move_to_position`、`move_to_location` | 轴可用且处于可接单状态；数值目标或由端点投影出的轴坐标在行程内，带载路径允许。 | `actual_position` 的目标误差及 `actual_speed` 均在容差内，产生 `AtTarget(轨,T)` 和 `Stopped(轨)`。 |
| 制停：`stop_motion` | 能控制目标轴并取得有效速度反馈。 | 制动后 `Stopped(轨)` 成立，加载物的支承与归属保持。中途制停只发布停止结果。 |

</details>

<a id="bind-lift-table"></a>

### 升降台 `lift_table`

**逐条件绑定（升降台）。** 设备输出 `actual_height`（REAL，m）、`moving` 和 `at_level`（BOOL）。S07 的轴组停稳由 `mount.stopped` 取值，即轨道与升降轴均停稳且无在途物料转移。位置和速度判断使用实际刚体采样。下文“接收确认”指同件在目标的偏差 < 0.02 m、速率 < 0.03 m/s 且存在目标接触支承，连续 4 个仿真步后提交本次交接（S07 实现）。

| 行为 | 行为说明 | 前置条件 ← 读取与比较 | 完成条件 ← 读取与比较 |
| --- | --- | --- | --- |
| `lift_to_location` | 按指定工位或格位求出对接高度，驱动升降平台到达该高度并停稳。 | 轴组停稳；请求的具名 `target` 由 `resolveDock(...).lift` 解出轴位移，检查负载、行程、带载路径及授权。 | 轨迹已收敛、`abs(实测升降轴位移 − 目标位移) < 0.005 m` 且平台刚体速率 < 0.01 m/s。反馈 `actual_height = restHeight + 实测位移`。 |
| `lift_to_level` | 把平台升降到指定高度；型号采用层号输入时，先按设备层高表换算。 | 高度模式从 `move_to_level`（m）取目标；层号模式须先把 `target_level` 经层高表换算。S07 取米制请求并扣除 `restHeight`，轴组停稳且目标在行程内。 | 将 `actual_height` 与本次目标高度比较并检查实速，阈值同上；`at_level == true` 只报告到位状态。 |
| `accept_material` | 将指定工件从对接来源接到平台承载点，并建立平台对该件的承载关系。 | 交接源实际支承 M，`owners[M] == 来源`，平台可接；检查轴组与来源端点对位、载荷／尺寸和预留。S07 源位偏差≤0.04 m、速率≤0.03 m/s。 | 接收确认后建立平台与 M 的承载约束，`mount.held == M`，按本次请求提交平台归属。 |
| `release_material` | 把平台上的工件交到目标支承位置，接收确认后解除平台对它的承载关系。 | `mount.held == M` 且来源归属匹配，双轴对齐目的地，目标支承、容量、预留与路径有效。 | 目标接收确认，`owners[M] == 目标`、平台解除该件的承载。目标为格位时同时核对同请求的存取记录。 |
| `transfer_material` | 沿已声明的对接路线转移指定工件。S07 的源或目标必须是本平台，并用短程直线移动模拟交接；带横移机构的型号按配置输送。 | S07 从载荷取 M／来源／目标，核对已声明路线、稳定支承、目标可用、轴对位、净空和虚拟交接距离。横移模块型号另要求 `transfer_ready == true`。 | 同件通过接收确认并提交目的地交接回执；传到平台时建立承载约束。 |
| `hold_lift` | 让升降轴受控停在当前位置并保持平台；支持在途保持的型号同时保存原任务。 | 参考型号按 `enableTag` 请求保持，要求保有载荷与原任务资源；S07 按轴保持命令及本模式准入核验。 | 升降轴 `settled == true`、`moving == false`。对在途保持型号还需读取原目标与任务身份，保持后不得作为原升降任务已到位。 |
| `resume_lift` | 让支持恢复的型号退出保持状态，继续同一升降任务的原目标。 | `enableTag == true`、保留任务仍有效，故障解除、资源有效、目标未覆盖。 | 读取任务状态转入原任务运行阶段，最终到位由原定位请求另行核对。 |
| `raise_transfer_chains` | 抬起选配的辅助横移链，使链条到达上工作位，准备接托或横移工件。 | `transfer_module == true`、主轴停稳、行程与资源允许；入 `popupTag == true`。 | 辅助机构实测到上位。按型号提供的实际位置或限位观测确认，启动命令和 `transfer_ready` 单独均不足以证明到位。 |
| `lower_transfer_chains` | 将选配的辅助横移链降至下工作位，同时维持工件已建立的支承关系。 | `transfer_module == true`、主轴停稳、工件有可靠支承或已交接；入 `popupTag == false`。 | 辅助机构实测到下位，工件原有持有或支承关系仍有效。 |

S07 虚拟交接与参考型号的辅助链属于不同配置。S07 的物理完成回执匹配 `runId`、`activationId` 和 `requestId`。[升降适配器](../../src/devices/lift_table/behavior.ts) · [物料接触与归属提交](../../src/runtime/services/MaterialTransferService.ts) · [选配横移接口](../../../test1/dsl_new/asset_contracts/assets/lift_transport.json)

<details>
<summary>通用行为语义与兼容入口</summary>

| 通用行为及已有入口 | 固有前置条件与信号 | 完成条件及可输出的证据 |
| --- | --- | --- |
| 高度定位：`lift_to_level`、`lift_to_location` | 平台可用、当前载荷在承重范围内；高度或具名端点可解析，行程与载荷扫掠路径允许。 | `actual_height` 进入目标容差，平台实际停稳，产生 `AtTarget(平台,T)` 和 `Stopped(平台)`。 |
| 对接转移：`accept_material`、`release_material`、`transfer_material` | 指定件在来源稳定受支承，源与目标已对位并停稳，接收端容量与必要预留有效，转移行程和路径可用。 | 目标实际支承同一件，来源交出、接收方登记。当平台接料时建立承载绑定；平台放料时核对目的支承并释放原绑定。按本次交接产生 `Transferred`。 |
| 保持、恢复和选配机构：`hold_lift`、`resume_lift`、`raise_transfer_chains`、`lower_transfer_chains` | 保持／恢复针对同一在途任务；辅助链要求配置有效、主平台安全停稳，降链时有可靠支承。 | 保持为减速停稳并保留原任务，恢复为原任务继续；辅助链动作需对应上位／下位的实际观测。控制量 `popupTag` 只发命令。 |

</details>

<a id="bind-storage-rack"></a>

### 仓储柜 `storage_rack`

**逐条件绑定（仓储服务）。** PLC 用 `cell_id: INT` 选择格位，将 `material_id`、`owner_task_id` 的 DINT 值映射为本次物料和任务。记 C 为解析后的格位、M 为物料。S07 已由升降台的交接调用库存服务：`world/state.inventory.occupancy[C]`、`reservations[C]`、`events[]` 是当前可查的引擎观测，内部预留身份采用 `runId/requestId`。以下 PLC 端口是独立仓储服务的契约投影；S07 的内部调用未证明各独立 PLC 操作入口已经接通。

| 服务／触发输入 | 行为说明 | 前置条件 ← 输入、反馈或台账判定 | 完成条件 ← 数据判定；输出端口 |
| --- | --- | --- | --- |
| `reserve_cell`：入 `reserve_request=TRUE`、本次 `request_id` | 为指定任务和工件预留一个可用格位，防止其他任务同时占用。 | C、M、任务号有效，格位容量与形状合适；`cell_available=TRUE` 所据的是所查格位尚能预留且无他人有效预留。申请时原子复核台账。 | 台账中出现本次请求对 C 的预留，出 `reservation_granted=TRUE`、对应 `reservation_id`，重算 `cell_available` 与 `free_cells`。 |
| `store_to_cell`：入 `store_request=TRUE`、本次 `request_id` | 在工件被搬入并得到支承后，将预留转成实际库存，记录这件工件存在哪个格位。 | `reservations[C]` 与当前任务／申请身份匹配，运输方实际持有 M，质量／尺寸允许，C 可接收。 | 搬运设备已确认 M 在 C 得到支承，台账提交后占用指向 M，出现关联同件、同槽、同请求的 `kind=stored` 事件。出 `stored=TRUE` 并关联 `result_id`；`cell_full` 按容量计算。 |
| `release_from_cell`：入 `release_request=TRUE`、本次 `request_id` | 在搬运设备实际取走工件后提交出库，清除该件的格位占用。 | `occupancy[C] == M`，任务身份和出库授权有效；接收方可接收 M，确认适用预留。 | 确认 M 实际离开、接收方取得同件，台账移除该件并记录 `kind=retrieved`；出 `released=TRUE` 并关联 `result_id`，重算 `cell_available`、`cell_full`、`free_cells`。 |
| `cancel_cell_reservation`：入 `cancel_reservation=TRUE`、本次 `request_id` | 按预留身份撤销一次尚未提交的格位申请，保留已有库存。 | 所查格位的预留与当前任务／原预留身份匹配，交接尚可撤销。 | 仅匹配的预留消失，实际占用保持；撤销成功后重算 `reservation_granted`、`cell_available` 和 `free_cells`，结果归于取消请求。 |
| `query_cell_state`：入 `cell_id`，服务查询 | 响应一次针对指定格位的查询，返回当前占用、可用性和预留归属。 | C 在注册槽位集合内，当前库存／预留快照有效。 | 返回该槽同一版本的占用、可预留性和预留归属，映射 `cell_full`、`cell_available`、`reservation_granted`、`reservation_id` 与 `free_cells`。 |
| `publish_storage_state`：库存、预留或回执更新触发 | 持续发布货架容量、格位占用和存取结果，供其他设备及调度器订阅。 | 读取有效的当前占用、预留和与请求相关联的服务反馈。 | 持续更新 `cell_available`、`cell_full`、`free_cells`、`reservation_granted`、`reservation_id`。仅已提交的相应事件锁存 `stored` 或 `released`，并关联 `result_id`。 |

[仓储服务契约](../../public/scene/S07/contracts/storage_rack.json) · [预留与提交台账](../../src/runtime/services/StorageRackRuntime.ts) · [S07 交接与物理观测绑定](../../src/runtime/assembly/WarehouseRuntimeAssembler.ts)

<details>
<summary>通用行为语义与兼容入口</summary>

| 通用服务及已有入口 | 固有前置条件与信号 | 完成条件及可输出的证据 |
| --- | --- | --- |
| 预留或取消：`reserve_cell`、`cancel_cell_reservation` | 格位存在、尺寸和容量合适并可被本请求预留；取消需匹配当前令牌与所有者。 | 预留产生 `Reserved(格位,owner)` 和令牌。取消仅释放对应预留，实际库存以物理交接登记为准。 |
| 入库／出库：`store_to_cell`、`release_from_cell` | 入库需有效格位授权和待放入的指定件；出库需格内确有同件、出库授权和可用接收方。 | 入库以同件实际放稳与格位占用提交为证；出库以接方实收、格位腾空与出库记录为证。支持由搬运设备的交接事务调用库存服务。 |
| 查询／发布：`query_cell_state`、`publish_storage_state` | 指定格位有效，库存记录可读。 | 查询返回当前格位与预留身份的有效快照；持续发布空位、占用及最近交接事件。 |

</details>

<a id="bind-human-operator"></a>

### 搬运人员 `human_operator`

| 行为 | 行为说明 | 前置条件概要 | 完成证据概要 |
| --- | --- | --- | --- |
| `carry_material` | 人物从源位置接近指定工件，用手部吸附搬到目标，放稳、松手后撤回。 | 手空，源端指定件可抓取，目标可接收，搬运路线已获准。 | 同件在目标得到支承，人物松手撤回，交接记录匹配本请求、物料和端点。 |

**逐条件绑定（`carry_material`）**

设 `M/S/D` 来自该行为载荷的 `material/source/target`，`w` 表示本轮、质量为 `good` 的引擎观测 `indexing/state`。下列给出已接入的 S11 提供者，装卸侧、工装及退避区均是这个型号的绑定。

| 阶段／条件键 | 信号或观测绑定、判定与结果 |
| --- | --- |
| 前置／`carry_material.ready`：空手、同件和区域 | **观测**：`w.active == M`、`w.holding == null`、`w.humanHome == true`、`w.robotHome == true`、`w.stopped[台] == true`，`w.measuredAngleDeg` 在装卸角容差内。**出** `holding_material: BOOL` 投影自 `w.holding`，物料 ID 由观测给出。 |
| 前置／同一 `ready`：源可取、目标可接 | 上料时 `w.onSource == true` 且 `w.tableMaterial == null`；下料时 `w.tableMaterial == M` 且物理约束指向该工装。动作核对载荷指定的抓口 ID、已声明路线、源支承和静止位置；该工艺另核对加工记录及分度次数。实际吸附前再次检查掌面到同件抓取点的距离 ≤ 人物参数 `position_tolerance_m`。 |
| 授权／`carry_material.authorized` | **仲裁**：就绪仍为真，且此激活持有人物、转台、机器人、装卸位与本件资源。**入** `execute: BOOL` 和 `request_id: DINT` 由网关在授权后提交；物料和源／目标端点通过冻结载荷传入。 |
| 持续／`carry_material.sustaining` | **出反馈＋观测**：人物 `error == false` 的样本有效，`w.robotHome && w.stopped[台]`。持件阶段另查本次吸附约束存在，掌面与抓取点的距离保持在容差内。 |
| 完成／`carry_material.completion` | **物理＋账本**：放下时先确认 D 的实际支承、同件落点和静止，退回时再次确认。要求 `w.humanHome && w.holding == null`、`requestState.outcome == "succeeded"`，且 `w.transfers` 中同一记录匹配 `r.requestId/M/S/D`。反馈为 **出** `holding_material == false` 和本次请求的 `done/result_id`。 |

[条件和资源](../../src/runtime/assembly/IndexedProcessingRuntimeAssembler.ts) · [实际支承与交接记录](../../src/runtime/services/IndexingCellMotion.ts) · [掌面吸附与撤离](../../src/devices/human_operator/behavior.ts)

<details>
<summary>通用行为语义与兼容入口</summary>

| 通用行为 | 固有前置条件与信号 | 完成条件及可输出的证据 |
| --- | --- | --- |
| 搬运：`carry_material` | `Ready(人)`、`Empty(手)`，同件 `At(M,S)` 且可拾取，源抓取口匹配，路线可通过，`CanReceive(D,M)`。捕获瞬间核对可达、距离与吸附约束。 | 指定物料在 D 稳定受支承、手已释放，接收登记成立并按请求撤到安全位置。对外输出 `SupportedAt(M,D)`、`Transferred(M,S,D,…)`、`Empty(手)`，以及有实测依据的撤离状态。 |

</details>

### 历史实验兼容 `processing_station`

以下是旧 `request_v1` 的实际绑定，保留为历史实验协议。三种动作的共同准入项是入 `enable=true`、出 `busy=false` 且 `error=false`、授权 `operation_allowed=true`、观测 `subject_present(M)=true` 且 `material_mass(M) ≤ max_payload_kg`。执行中保持使能和授权，命令载荷携带同一 `material_id`。

| 行为 | 行为说明 | 附加前置／持续条件读取 | 本次完成条件读取 |
| --- | --- | --- | --- |
| `clamp`，入 `command_code=1` | 在旧实验工站的夹具中固定指定工件，为后续工艺保持装夹状态。 | 共同准入项 | 物理夹持观测 `subject_clamped(M)=true`。 |
| `process_material`，入 `command_code=2`、`recipe_id` | 在旧实验工站中按选定配方处理已装夹工件，并留下与该工件及配方关联的操作记录。 | 夹持和配方观测 `subject_clamped(M)=true`、`recipe_available(M,recipe)=true`，出 `process_ready=true` 且 `interlock_ok=true`。加工中保持夹持和互锁。 | 出 `cycle_finished=true` **且**同工件同配方的观测 `operation_recorded(M,recipe)=true` **且** `process_stopped=true`。 |
| `unclamp`，入 `command_code=3` | 打开旧实验工站的夹具，让工件在工位上保持支承，供搬运设备取走。 | 另读观测 `process_stopped=true` | 物理观测 `subject_unclamped(M)=true` 且 `subject_present(M)=true`，工件仍在位。 |

[旧实验工站协议](../../public/scene/S05/contracts/processing_station.json)


## 3. DSL 怎样自动连信号

### 准备阶段生成绑定表

1. **实例化角色。** 根据 DSL 载荷与工程连接解析设备、物料、源端、目标端、工具和工位。例如同一个 `carry_material(M,S,D)` 可以绑定到小车和转台，也可以绑定到其他兼容端点。检查端点角色、类型、方向、单位、参考系、坐标标定与已注册的提供者。
2. **生成控制边。** 按 DSL 的顺序、分支、并行与循环建立激活关系。有限前驱成功产生本轮控制令牌，令后继有资格检查自身条件。两个独立动作可以只有控制边，首步也可以只依赖有效初始状态。
3. **生成条件信号边。** 对后继的每项需求，从其本机反馈、相连设备的已声明结果、物理观测、库存或资源服务中寻找同语义、同角色的生产者。结果可精确匹配，或通过已登记且有证据支撑的转换绑定。例如已实测的同件稳定放置可以同时提供“位于目标”和“由目标支承”；物料到出口不能推出下游容量。生成记录包含生产实例与结果、消费实例与条件、主体与端点映射、比较／容差、作用域与新鲜度。
4. **检查可执行性。** 必需的条件无提供者、多个提供者无法消歧、单位或端点不兼容、同一命令输入有多个写入者时，在准备阶段指出具体工步和条件。双方都等对方完成且无初始证据或外部触发的交接会阻塞，需先建立接收许可或按同一交接事务协调双方。

### 执行阶段核对事实并提交

- 已授权的控制网关是命令端口的唯一写入方。预检不得把本动作尚未写出的 `execute`、`accepted` 或 `done` 当作自己的准入条件。相应 `done` 在独立完成证据成立后锁存。
- 上一动作 A 的成功回执匹配 A 的运行、激活和请求号。绑定表将 A 的结果与下一动作 B **同一物料、同一实际端点和当前工单／循环轮次**关联。B 在提交时有自己的请求号。
- 电平状态逐步重读。例如工件随后被取走，先前的放置记录仍然有效，但“工件现在在该位”已经失效。一次性交付和加工记录按身份去重，多条分支可以读同一事实，一件物料只提交一次所有权转移。
- 当前驱控制条件、本机条件和所需外部条件均满足时，调度器原子申请资源，再复核授权并向本实例网关提交命令。失败、取消、超时均不发送成功令牌。并行汇合只核对本轮应参加的分支，互斥资源仍由仲裁器分配。
- PLC 上的 `done` 是该次请求完成后的协议投影。调度器使用有来源、有身份的结果和当前信号判断后继条件；设备网关按单写者规则发 `execute` 等命令。信号边可以画成梯形图中的依赖，不会代替实际传感器写入一个“已到位”或“已松手”。

### 示例：输送到位后，机械臂取件

绑定参数为同一物料 M，传送带目标和机械臂来源都解析到端点 E。具体接线如下。

| 后继需要什么 | 绑定到什么 | 何时判断 |
| --- | --- | --- |
| 该轮取件工步可以激活 | DSL 顺序边读取本次输送请求的成功结果 | 输送到位被独立确认之后 |
| 指定件现在可从 E 拾取 | 输送结果给出 `At(M,E)`、`SupportedAt(M,E)`；源端当前观测确认同件仍在位。要求静止的源再读取 `Stopped(带)` | 激活时及实际捕获前 |
| 机械臂能抓 | 本机的 `Ready(臂)`、`Empty(臂)`，有效抓取点、载荷和轨迹检查。夹具到位时核对捕获条件 | 接单及对应执行阶段 |
| 本次取放已获授权 | 资源服务核对夹具、物料、必要端点与目标预留；有效令牌属于本次作业 | 资源申请后、设备提交前 |

若前驱的结果出口为 `SupportedAt(subject,target)`，后继的取料条件入口为 `SupportedAt(subject,source)`，准备时可生成一条数据边：将前驱 `subject/target` 与后继 `subject/source` 统一绑定为 M/E，读取 E 的当前支承观测。另建一条控制边，从前驱关联成功结果连到后继激活。即便结果电平以前成立，当前源端若已无该件，这条数据边会返回假。

同一个取件行为用于托盘时，源端的槽位绑定和实际支承提供 `At(M,E)`、`SupportedAt(M,E)`。机械臂的契约与剩余条件保持一致。

### 示例：人放件、转台分度、机器人工具加工

人的放置结果给出 `SupportedAt(M,工装)`、`Empty(手)` 与交接记录。转台按带载策略还检查 `RetainedAt(M,工装)`、相关区域清空和轴可用：工件仅放上台面时，固定条件不会自动成立。分度完成给出 `AtTarget(台,加工侧)`、`Stopped(台)` 并验证同件仍在工装。机器人从已绑定工装姿态与工件接口解析当前加工目标，再核验工具兼容、作业区和目标可达。只有实测枪尖对准且工艺周期有效才产生 `Processed(M,…)`。换用其他送料者或其他工位角度时替换端点与信号生产者即可。

## 4. 迁移与验收

现有调度器已实现前置检查、资源仲裁、请求回执、完成检查和 DSL 节点推进。拟新增的工作是把上文的需求、结果、实际提供者和匹配规则放到设备模板及注册表，在场景准备时生成并校验跨实例的信号绑定表，然后交给现有调度器使用。运行中的专用场景互锁须逐项迁移，保持其原有物理与权限约束。[工步调度](../../src/runtime/scheduler/ProcessScheduler.ts) · [请求账本](../../src/runtime/scheduler/RequestBook.ts) · [场景执行](../../src/runtime/engine/SceneRuntimeProgram.ts)

验收至少覆盖以下情形：

- 同一抓放契约分别从输送带、托盘槽取料，只替换生产者绑定。首步从初始在位观测开始，能够正常接单。
- 前驱完成但源件已被取走、物料 ID 或端点不符、夹具已占、转台未固定工件，后继均须等待或给出具体失败原因。
- 上一轮的锁存 `done` 无法放行这一轮；两臂并发竞争同一件或同一格位时只有获准者能提交。
- 单位或角色不符、条件缺提供者、存在多义绑定或交接双方循环等待时，准备诊断列出未能建立的信号边。
- 历史矩阵的每个“原设备类型＋行为 ID”都能追溯到本表的行为、被动响应、观测、内部步骤或实验兼容条目。比较行为开始与完成的证据、信号写入权、取消语义及最终工件归属；合并后继续运行六个既有候选场景回归。

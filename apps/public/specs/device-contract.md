# 工作台设备契约规范

工作台规范 2026-11-25 · 基准 `3c0feda`

适用对象为设备类型模板、整场景的设备定义与实例，以及工作台发布的独立 GLB 型号。本文承接仓库中的 `test1/docs/设备契约.md`、`参数契约.md`、`schema.md` 和 `统一条件表达式.md`，以实际支持的编译、装配和物理执行路径确定每个字段的含义。工步、批次和动作调用见[工作台 DSL 规范](./dsl.md)。

## 设备应满足的四项要求

1. **设备身份与参数可解析。** 给设备定义稳定 ID、类型和修订。为每个配置量声明类型、单位（有量纲时）、必需性和修改时机。运行前从型号默认值及实例覆盖中解析所需的值。
2. **模型与接口可定位。** 给出模型和节点的绑定依据。安装、抓取、加工、承载等用途分别按型号提供命名坐标系、参考系和兼容角色。PLC 信号在 `signal_ports` 单独声明。
3. **每个行为有明确的调用与判据。** 声明行为 ID、可调度性、动作参数或载荷、输入和输出信号。前置、持续和完成判据引用本设备注册的参数、观测或授权。有限动作的完成要能追溯到本次请求及适用的物料身份，连续行为声明持续模式。
4. **声明能连接到实际执行。** 可执行型号需将行为签名匹配到设备工厂和驱动，提供相应的物理或信号反馈。尚未标定的几何、缺少的执行器或互锁应说明适用范围和准备结果。

新建设备时，从第 6 节选取该类型的 `contract.json` 源模板，再按下文补齐型号和实例数据。

## 1. 作者应交付哪些文件

| 文件 | 内容 | 谁使用 |
| --- | --- | --- |
| `apps/src/devices/<device_type>/contract.json` | 该类型的通用参数、空间接口、信号、行为和条件 | 设备库发布器 |
| 同目录的 `behavior.ts`、`index.ts` | 设备的行为实现及工厂 | 引擎通过 `apps/src/devices/registry.ts` 查找受支持的执行签名 |
| `apps/src/devices/catalog.json` 中的型号配置及其引用的 `contract-overrides.json` | 选择本型号支持的行为和信号，补充型号专用字段或裁剪能力 | 发布器展开继承和差量覆盖 |
| `apps/public/scene/Sxx/contracts/*.json` 或 `apps/public/modles/<型号>/schema.json` | 可独立读取的发布快照。同型实例可复用一个定义 | 场景构建器、独立型号导入器 |
| `apps/public/scene/Sxx/device/<实例>.json` | 将一个设备或预制体身份绑定到定义、模型节点、参数覆盖、空间位置和标定 | 场景构建器生成实例化后的数据 |
| `scene.json`、`process.py`、`task-spec.json` | 分别描述现场装配、工艺调用及独立验收目标 | 引擎根据 DSL 调度动作，以指定目标验收 |

修改所有型号共享的行为时编辑类型模板。修改一个型号时编辑其配置或覆盖源。仅位置、尺寸取值或节点变化时编辑实例。设备库构建后发布快照、契约锁与执行签名。手工编辑生成的快照会造成来源不一致，重新构建时也会被覆盖。可对读 [S07 滑轨发布契约](../scene/S07/contracts/linear_rail.json)、[T1 实例](../scene/S07/device/T1.json)及[装配连接](../scene/S07/scene.json)。

## 2. 新 DeviceSpec 的顶层结构

| 字段 | 写法 |
| --- | --- |
| `schema_type`、`contract_version` | 标准设备写 `DeviceSpec`。格式版本使用引擎已经识别的字符串 `1.1`、`1.2`、`1.3`、`1.4`。本文的文档版次不写入该字段。 |
| `schema_id`、`device_spec_id`、`version` | 前两个字段均为同一个非空定义 ID。发布型号时以 `version` 标明该定义的修订。变更行为公开签名、参数含义或空间接口时同步更新定义修订及使用方的注册/锁定记录。 |
| `device_type`、`display_name`、`description` | 设备类型见第 6 节。新定义及其型号覆盖提供非空显示名和清晰的用途说明，发布时保留顶层 `description`。 |
| `asset` | 声明 `model_format: "glb"`、`model_key`。已发布实际模型按包布局给相对路径，并按入口关联模型哈希。按需指定根节点和导入变换。模板可保留待绑定模型键。 |
| `params_schema`、`type_specific_contract` | 前者是参数名到参数定义的映射，后者保存轴、关节、接口几何、支承面、承载或加工性质等类型专属数据。 |
| `interfaces`、`signal_ports` | 分别为空间接口数组、设备逻辑信号数组。各类条目的 ID 在本设备内唯一，字段见第 4、5 节。 |
| `transport_behaviors` | 行为数组，包含设备能力、控制入口、服务、内部步骤和被动观测。逐项声明参数、可调度性、信号和执行条件。 |
| `runtime_contract` | 至少包含 `observation_definitions`、`authorization_definitions` 两个映射。按型号补资源/故障约定和可选 `condition_model`。 |
| `runtime_execution_contract` | 保存当前型号的执行及信号管理约定。按入口提供 `signal_management`、命令载荷模板 `payload_templates`、执行模板或候选配置等数据。独立 DeviceSpec 导入器会检查 `signal_management`。 |

`1.1` 是通用声明结构。S04、S06、S07、S11 等场景通过有注册实现的场景配置装配其设备。`1.2` 用于受限接触输送，`1.3` 支持声明式刚体，`1.4` 支持机械臂运动学和虚拟抓持。格式版本、设备修订、执行器引用、GLB 哈希各自独立。准备运行时需要提供真实模型、校准值、可匹配的完整动作签名和运行时观测。可参考[独立输送带型号](../modles/Conveyor_aankws/schema.json)和[独立 UR10 型号](../modles/robot_UR10/schema.json)。

**旧包的两个兼容事实。** 基准版本 52 份标准场景快照中有 41 份因型号覆盖省略顶层 `description`。现有整场导入路径可读取这些快照，独立 DeviceSpec 作者须按上述完整字段交付。历史 `standard.robot_arm@1.1.0` 在相同设备修订内新增过 `mount_base` 和 `pick_and_place.optional_fields.grasp`。核对旧包身份时应同时核对快照哈希、GLB 哈希、行为签名与来源锁。编译结果中的 `model_sha256`、`source_hashes` 与包内 `.generated/device-contracts.lock.json` 用于追溯。模板中的 `pending_adapter`、表现为声明状态的条件或型号名称本身都不能作为执行准入证据。

## 3. 参数、实例值与动作请求

| 数据 | 位置和规则 | 实例 |
| --- | --- | --- |
| 可配置参数 | `params_schema.<name>` 对每项写 `type`、`required`、`mutability`、`description`。`type` 为 `number`、`integer`、`boolean`、`string`、`enum`。按需写 `default`、`min`、`max`、`unit`、`options`、`required_when`。有量纲数值声明单位，数值有限，整数取整型，边界含端点，枚举默认值须在选项中。 | 机床 `cycle_time_s` 为秒，S06 默认 2 s，`stopped_only`。 |
| 参数来源 | 型号声明默认值。场景 `device/*.json` 用 `parameters` 提供实例覆盖，独立工作台项目实例使用 `paramOverrides`。需要的值由默认值或覆盖提供。`required_when` 引用已声明的 `parameter` 及 `equals`。条件成立时必须有值。`*_param` 引用本设备已声明的参数。 | 独立工件允许质量待填写。准备实际物理执行时必须有正质量。 |
| 修改时机 | `stopped_only` 表示停机配置。`runtime_setpoint` 表示允许通过已实现的单写入者、限值校验和采样机制调整设定值。 | 改后台 JSON 的默认值不会给正在执行的动作发送新请求。 |
| 单次动作标量 | 行为的 `arguments_schema` 声明该动作接收的字段、类型、必需性、单位和可用范围。DSL 调用按该签名提供参数。具名位置也可采用型号声明的 `semantic_type: "location_ref"`。 | S07 滑轨 `move_to_position.position_m` 为沿本轴从零位起算的有符号绝对位置。升降台 `lift_to_level.move_to_level` 为平台相对本设备基座的高度，均为 m。S11 `rotate_to_station.angleTag` 为绝对工位角，单位 °。 |
| 单次结构化载荷 | `runtime_execution_contract.payload_templates.<行为>` 用 `fields` 登记必填字段、`optional_fields` 登记可选字段，二者键不重叠。构建器按实例生成 `command_payloads`，DSL 选取绑定并按类型提供字段。 | 普通 `pick_and_place` 指定物料、来源和目标。支持具名抓取的型号可传 `grasp`。S04 的双臂交接还需要接收方与两端抓取帧。 |
| 实测反馈 | 传感、刚体接触、持有关系、轴读数、槽位台账和请求回执由运行时产生，按实例与请求关联。 | 命令值、参数默认值和实测 `actual_height` 分别保留。 |

新设备的动作参数可以直接采用本型号的既有签名。旧 S07 的米制动作参数只有 `type`、`required`、`unit` 一类的紧凑写法。`params_schema` 的四个必填元字段适用于设备配置参数。S04/S07 等发布物在 `test1/dsl_new` 原八类待接入模板的严格模式下不能直接通过。新增字段要先声明、接入校验与执行器，再用于正常 DSL 调用。

下面是 [S01 机械臂契约](../scene/S01/contracts/robot_arm.json)中 `runtime_execution_contract.payload_templates.pick_and_place` 的实际值。动作的 `arguments_schema` 可以为空。传入的结构载荷仍受此绑定约束。

```json
{
  "fields": {
    "material": "material_ref",
    "source": "location_ref",
    "target": "location_ref"
  },
  "status": "pending_model_adapter",
  "target_payload_schema": null,
  "optional_fields": {
    "grasp": "grasp_frame_ref"
  }
}
```

## 4. 安装、抓取、加工与端点

空间接口保存在 `interfaces[]`，每项写 `interface_id`、`name`、`capabilities.snap`。`snap.role` 描述自身角色，`snap.accepts` 列出允许的对端角色。需要配对时双向相容。位置来源在固定 `local_frame`、参数派生 `local_frame_rule`、待标定 `local_frame_pending: true` 中选一个。固定帧的 `position` 单位为米，`forward`、`up` 为正交单位向量，方向相对于设备局部系。`signal_ports` 独立存放 PLC 信号。旧 `physical_interfaces`、`process_ports`、`interface_bindings` 不与统一格式混写。

| 配置用途 | 当前建模规则与动作读取位置 |
| --- | --- |
| 所有设备的底部安装 | 十个模板均有 `mount_base`。模型发布或关联时，在设备静止姿态按自身拥有的几何测量局部包围框，在 Y 向上的设备安装参考系中取底面中心 `((xmin+xmax)/2, ymin, (zmin+zmax)/2)`，再将位置和朝向表示为接口的 `local_frame`。无可用几何的模板保持待标定。滑轨另有随滑座移动的 `carriage_mount`，使用滑座安装面的模型标定。当前定位编译器要求米制单位缩放。 |
| S07 挂载连接 | `scene.json.connections[]` 用 `id` 和端点 `a/b` 保存 `instanceId`、`interfaceId`。挂载方向由端口角色确定。校验角色、占用、单父、无环及实测帧对齐。S07 的 T1/L1 与 T2/L2 各有一条连接。旧包可通过成对的 `mounted_device`、`mounted_on` 读取已有装配。安装关系用于设备随动。平台承载箱体则由接放料、物理支承与持有约束管理。 |
| S04、普通具名抓取 | `type_specific_contract.grasping` 声明 `frame_source: "material_local_m"` 及 `frames.<id>.position_m/approach_axis`，可声明 `preferred_grasp`。本次抓取按物料实际位姿将指定局部帧变换到世界系。S04 传 `giver_grasp='head'` 和 `receiver_grasp='tail'`。出口带的 `model.transport_pose` 指定轴向、接触帧和倾角容差。普通抓取在省略名字时可用已声明的默认帧或唯一帧。原顶面抓取型号保留其已实现路径。显式指定的名字必须存在。 |
| S06 机床工位与工件 | 机床发布契约用 `interfaces[]` 中 `interface_id="work"` 的条目声明加工位空间帧，设备实例用 `locations["MC1.work"]` 绑定具名定位点和几何基准。机械臂的来源/目的由 DSL 指定。工件实例 `model.processing` 经编译进入 `type_specific_contract.processing`，其中 `initial_state`、`finished_state`、`finished_template` 描述状态与外观切换。 |
| S11 手、工具、工件与工装 | 该场景配置复用顶层 `interfaces[]` 的具名空间帧作为工艺几何。工件 `handle` 是 `grasp_target`，`weld` 是 `process_target`，`base` 与转台 `slot1` 配合。人物 `hand`、机械臂 `torch` 分别具有 `human_gripper`、`weld_tool` 角色。搬运的 `grasp_frame_ref` 还要求工件 `grasping.frames` 有同名 `handle`，两份几何应指向同一物理锚点。加工的 `tool_interface_ref`、`process_interface_ref` 分别查对应设备的 `interfaces[]` 并核验双向角色。工件 `processing.interface` 指向 `weld`。 |

在新型号上复用一种工艺时，应按该执行配置实际读取的位置提供几何。可取性、加工许可与请求完成分别由条件提供者判定，空间帧本身仅给出位置、朝向和允许配对的角色。[S04 瓶子](../scene/S04/contracts/workpiece.json) · [S04 出口](../scene/S04/device/C2.json) · [S06 加工位](../scene/S06/device/MC1.json) · [S06 工件](../scene/S06/device/Workpiece.json) · [S11 工件](../scene/S11/contracts/workpiece.json) · [S11 人物](../scene/S11/contracts/human_operator.json) · [S11 转台工位](../scene/S11/device/T1.json)

## 5. 行为、信号与完成证据

每项 `transport_behaviors[]` 填写 `behavior_id`、`display_name`、`behavior_type`、`schedulable`、`executor_ref`、`implementation_status`、`arguments_schema`、`trigger`、`input_signals`、`output_signals`、`condition_contract`、`completion_contract`。行为类型包括 `action`、`composite`、`service`、`passive`、`observer`、`internal`。DSL 作者还需确认该行为在所用型号上可调度、所选能力已启用、运行装配器有对应实现。例如单设备机械臂任务中的关节步骤受单机命令协议约束。整场接口按所发布的场景行为签名匹配。

**信号。** 每条 `signal_ports[]` 必须有 `port_id`、`direction`、`value_type`、`plc_type`、`signal_role`、`retention`、`description`，有量纲时给 `unit`。方向按设备/服务视角写 `input` 或 `output`。PLC 的 `BOOL` 对应 `boolean`，`INT` 与 `DINT` 对应 `integer`，`REAL` 对应 `number`。行为的 `input_signals/output_signals` 必须引用本设备中方向相符的端口。编译器派生 `<实例>/<端口>` 逻辑名，运行时还隔离场景与会话。项目的 PLC 变量映射、实际采样、当前写入者分别管理。读取反馈应核对身份、质量、时效和保持策略。

**请求。** 有限动作在接受时锁定同次请求的参数和身份。常用握手包括触发、`request_id`、`accepted`、`busy`、`done`、`result_id` 和 `error`。触发名、故障码、复位与状态端口以型号发布的 `signal_ports` 为准。关联 `runId`、实例、`activationId`、`requestId` 和需要的物料身份后才能消费回执。PLC 连续控制使用其注册的单写入者和停止策略。机床 S06 与人物 S11 等旧快照的端口集合小于通用模板。

**条件。** 行为的 `condition_contract.preconditions`、`sustaining_conditions` 和 `completion_contract.checks` 中的检查项形如 `{id,label,source,key,equals}`。`source` 取 `parameter`、`observation` 或 `authorization`，分别查本设备的 `params_schema`、`runtime_contract.observation_definitions` 或 `runtime_contract.authorization_definitions`。前置条件描述本设备、目标、载荷及必要互锁此刻是否满足。持续条件在执行期间验证。有限动作以 `mode: "observed"` 给出可观测的完成依据，持续状态用 `mode: "continuous"` 声明。遵循 `missing_value_policy: "unknown_blocks_execution"` 和 `timer_or_progress_is_success: false`。资源授权、控制流顺序、物理完成属于不同的判据。

支持 `ac-condition/0.1` 的型号用定义的 `expression_ref` 引用 `condition_model.expressions[key]`。其中 `structured` 表达式通过 `bindings` 读取具名信号、参数、请求、资源授权或物理观测。`opaque` 将判定交给已有原生提供者。旧型号可省略 `condition_model`，由注册执行路径解释条件。定义中 `signal_refs` 给出有关的信号。判断式的与、或、比较和所需物理证据应读实际表达式或提供者实现。声明的 `execution_mode: "declaration_only"` 和运行时选择表达式提供者可以并存。

结构化条件支持 `all`、`any`、`not`、`compare`、`ref` 和带单位的 `literal`。比较的两端类型和单位要匹配，根结果是布尔值。绑定 `kind` 可以是 `signal`、`parameter`、`profile`、`request`、`observation` 或 `authorization`。信号绑定要给出本设备端口、关联作用域、采样质量和时效。引用的参数、请求或测量值缺失时按三值逻辑处理，只有判据明确为真才可放行。这里的表达式属于设备契约。工艺 DSL 能直接编译的表达式见[DSL 规范](./dsl.md)。

### S01 输送到出口的条件绑定

以下名称均来自 [S01 输送带发布契约](../scene/S01/contracts/conveyor.json)。省略的绑定前缀均为 `transport_to_exit.`。

| 时点 | 可从契约核对的处理 |
| --- | --- |
| 调用 | `transport_to_exit(subject_id)` 接收载荷登记号。`subject_id` 为必填整数，范围 1 至 2147483647。声明的输入含 `execute`、`request_id`、`runTag`、`speedTag`。 |
| 前置 | `pre_1`、`pre_2` 的 `source` 为 `observation`。在 `observation_definitions` 中按完整 key 找到 `expression_ref`。`pre_1` 的 `all` 要求 `subject_admitted` 和 `exit_path_valid`。`pre_2` 要求 `path_unblocked`。这些绑定读取指定主体的现场观测。 |
| 持续 | `sustaining` 组合 `matching_accepted`、对 `error_run` 的取反，以及 `transport_integrity`。`error_run` 通过 `kind: "signal"` 绑定本输送带的 `error` 输出，`matching_accepted` 则从本请求账本读取。 |
| 完成 | `completion` 要求 `matching_success`、`target_error_m <= position_tolerance_m`、`target_supported` 和 `subject_and_drives_stationary`。行为输出含 `part_ready`、`done`、`result_id`。该次到位完成后，实际交付仍由 `release_material` 单独确认。 |

上表的 `error_run` 对应以下完整绑定。它读取本次运行中质量为 `good` 的 `error` 端口，持续条件中的 `not` 对读数取反。

```json
{
  "kind": "signal",
  "behavior": "transport_to_exit",
  "value_type": "boolean",
  "unit": "1",
  "device": "self",
  "port": "error",
  "scope": "run",
  "required_quality": "good",
  "freshness": "signal_definition"
}
```

**S07 已知的信号边界。** 滑轨 `move_to_position(position_m)`、升降台 `lift_to_level(move_to_level)` 的米制目标由驱动直接读取请求参数，按实测到位与停稳反馈完成。此路径接单时写触发与 `request_id`，尚未把目标同步写入已声明的 `target_position`、`move_to_level` PLC 输入。现有轴入口也未用 `enable=false` 或 `enableTag=false` 拒绝新请求。因此仿真可验证轴运动。涉及 PLC 设定值写入、失能互锁的验收须单独记录为待接通。S11 转台适配器已有对 `angleTag` 的显式写入。[S07 滑轨定义](../scene/S07/contracts/linear_rail.json) · [S07 升降台定义](../scene/S07/contracts/lift_table.json) · [S11 转台定义](../scene/S11/contracts/rotary_table.json)

## 6. 十类设备契约模板与行为选用

下表给出从仓库根目录起算的十个源模板路径、真实参数名与常用行为。每个模板所在目录中的 `behavior.ts` 和 `index.ts` 分别维护行为实现和工厂。完整能力集以类型模板和该型号发布的 `transport_behaviors` 为准。不同场景的型号可裁剪同一设备类型的动作与端口。

| 设备类型 | 源契约模板（仓库路径） | 已声明的参数举例 | 常用行为与判据 |
| --- | --- | --- | --- |
| `robot_arm` 机械臂 | `apps/src/devices/robot_arm/contract.json` | `joint_speed_rad_s`、`max_payload_kg` | `pick_and_place`、`move_to_pose`、`process_material`。按指定物料和抓取接口建立真实持有，按目标支承与位置确认放置。归位由相应动作验证。S04 已有 `pick_and_handoff` 和 `place_held_material` 的交接绑定，分别指定交出、接收及已持件放料。`execute_job` 用于已支持的单机任务入口。 |
| `conveyor` 输送带 | `apps/src/devices/conveyor/contract.json` | `speed_mps`、`capacity` | `transport_to_position`、`transport_to_exit`、`stop_conveying`、`release_material`。到位需核对指定载荷、位置及实际运动状态，交付还需接收端证据。 |
| `rotary_table` 旋转台 | `apps/src/devices/rotary_table/contract.json` | `rotate_speed_deg_s`、`angle_tolerance_deg` | `rotate_to_station` 按已配置工位和请求角度分度，保持载荷与工装关系，以实际角度、容差和停稳确认。 |
| `machine_tool` 加工机床 | `apps/src/devices/machine_tool/contract.json` | `cycle_time_s` | `machine_material(subject_id)` 在同一工件稳定位于加工点、机床可用、机械臂退位且资源获准时开始。持续验证支承和互锁，完成时确认成品状态及匹配回执。 |
| `material_source_station` 出料口 | `apps/src/devices/material_source_station/contract.json` | `product_spec`、`buffer_capacity` | `produce_material`、`present_material` 可分别声明生产和呈送。有限任务可由组装后的供料服务按身份和支承接纳。计数来自已接纳物料。 |
| `workpiece` 物料、承载物料 | `apps/src/devices/workpiece/contract.json` | `mass_kg`、`shape` | `be_picked`、`be_carried`、`be_placed` 等是被动响应。带可选 `type_specific_contract.carrying` 的物料可承载其他物料，`slots` 给唯一槽位 ID、适用的局部坐标/支承层。按型号声明 `max_load_kg`、`allow_partial_load` 等。实际入槽、随动、释放和预留归属由引擎记录。S02 的 DSL 指定各类件数，托盘槽位和支承层由预制体配置。 |
| `linear_rail` 滑轨 | `apps/src/devices/linear_rail/contract.json` | `travel_speed_mps`、`position_tolerance_m` | `move_to_position`、`move_to_location`、`stop_motion`。按局部轴、零位、行程和实例挂载关系带动设备。检查实测位置、停稳与适用的带载净空。 |
| `lift_table` 升降台 | `apps/src/devices/lift_table/contract.json` | `max_height_m`、`max_payload_kg` | `lift_to_level`、`lift_to_location`、`accept_material`、`release_material`。定位与交接分别调用。接放前验证对齐、停稳、源支承与目标可接收，交接完成后复核位置与持有/支承归属。 |
| `storage_rack` 仓储柜 | `apps/src/devices/storage_rack/contract.json` | `rows`、`columns`、`capacity_per_cell` | `reserve_cell`、`store_to_cell`、`release_from_cell`、`cancel_cell_reservation`、`query_cell_state` 描述库位服务。实际搬运由设备执行，服务按物理交接结果提交库存。S07 由升降台交接调用库存服务。 |
| `human_operator` 人物 | `apps/src/devices/human_operator/contract.json` | `travel_speed_mps`、`lift_height_m` | `carry_material` 载荷明确物料、来源、目标和抓取接口，手部到位后吸附，移动到目标、释放并确认支承与撤离。 |

保留旧 `workpiece_carrier` 的发布格式和槽位名，导入准备阶段可映射为 `workpiece` 的承载能力。S05、S08、S09、S12 另有四份 `processing_station` 文件，均为 `ExperimentalAssetContract`。它们可作为现有包中的实验声明被读取，涉及这些设备的动作保留实验阻塞，不能据此套用 S06 已实现的 `machine_tool` 工厂。[S02 托盘实例](../scene/S02/device/Pallet.json) · [S06 标准机床](../scene/S06/contracts/machine_tool.json) · [S05 实验加工设备](../scene/S05/contracts/processing_station.json)

## 7. 从实例到运行验收

1. **声明与绑定。** 整场实例使用 `schema_version: "scene-device/0.2"`、唯一 `instance_id`、包内相对 `contract_ref`、`node_binding`。按需要提供 `parameters`、`locations`、`calibrations`、`model` 或预制体信息。已绑定节点引用对应 GLB 及其哈希，按实际层级确定拥有的网格。可选 `geometry_nodes` 限定所有权。设备间的挂载和运行物料的支承分别建模。
2. **发布与编译。** 在 `apps` 下运行 `npm run catalog:models` 与 `npm run catalog:scenes`。检查发布快照、实例参数、工步引用的行为和目标、单位、资源、信号方向、条件注册键以及包源哈希。绑定未解析、实验能力、缺校准等阻塞应保留到准备阶段解释。
3. **准备与执行。** 选择支持该设备组合的运行配置，按设备库检查型号签名与可用观察者。用一条合法请求验证从提交、接单、持续监控、完成到下一步。再以错误接口、错主体、越限或失效支承核对拒绝路径。对抓放或带载运动，还需核对停止时的实际归属。
4. **验收范围。** 工作台构建检查和 `python -B -m unittest discover -s scripts/tests` 可验证作者输入及构建层。执行能力由实际物理回放、PLC 信号核对和独立目标验收确认。`test1/dsl_new/asset_contracts` 保留八类待接入模板的历史校验基线。当前十类工作台及其已注册型号使用本文口径。

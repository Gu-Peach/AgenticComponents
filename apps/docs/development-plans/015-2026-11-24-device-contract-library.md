# 015 通用设备契约与行为库

| 项目 | 内容 |
| --- | --- |
| 阶段 | 开发方案。本文记录现状、目标目录、迁移顺序和合并条件。 |
| 开发分支 | `refactor/device-contract-library` |
| 基线 | 2026-11-24，`main@4b7a69c` |
| 适用入口 | 单设备实验、已有场景包，以及后续由独立设备实例搭建的场景 |

## 1. 目标与归属

设备库按十种设备类型划分目录。托盘使用物料（`workpiece`）类型，通过可选承载属性描述它能承载哪些工件、这些工件放在哪里。定义新型号时，从该类型的契约模板选择能力，补齐模型、接口和参数；为设备新增行为时，在同一目录维护声明、执行实现和判定动作完成所需的观测。引擎按照设备类型、明确的契约修订及所选能力查找实现。

DSL 负责组织动作的先后、并行、循环及本次调用的参数。以 S11 为例，人物上料、转台正向分度、机械臂加工、转台返回和人物下料的顺序归 DSL；怎样吸附、何时确认分度到位、枪尖对准多久才完成加工，分别归人物、转台和机械臂。场景提供实际设备、接口连接、共享区域、供收料规则和独立验收目标。

本轮交付这份方案。后续实施依次交付设备库、旧入口迁移和独立设备组合的最小运行验证，验收后合入主线。

## 2. 目标目录与文件职责

十类设备统一采用同一级目录，每个目录固定三份源文件。用机械臂举例：

```text
apps/src/devices/
  catalog.json                 类型、契约修订、型号能力选择与历史引用的索引
  registry.ts                  静态登记十类设备工厂，供执行入口查找
  robot_arm/
    contract.json              符合通用 DeviceSpec 的机械臂类型模板
    behavior.ts                此类型所有行为、设备专属运动与条件判定
    index.ts                   声明模块身份，导出每实例工厂
```

`robot_arm`、`conveyor`、`rotary_table`、`machine_tool`、`material_source_station`、`workpiece`、`linear_rail`、`lift_table`、`storage_rack`、`human_operator` 全部采用这个结构，包括被动物料。托盘复用 `workpiece` 的工厂和承载属性。物料目录的 `behavior.ts` 封装受物理驱动的响应、交接与观测；普通物料可以没有可调度动作。

| 文件 | 必须承担的职责 |
| --- | --- |
| `contract.json` | 十类共用 [DeviceSpec 顶层结构、字段与引用规则](../../../test1/docs/设备契约.md)。模板统一使用 `params_schema`、`interfaces`、`signal_ports`、`transport_behaviors`、`type_specific_contract`、`runtime_contract` 和 `runtime_execution_contract` 等既有字段。按类型填写参数、空间接口、信号、行为签名、前置／持续／完成条件及类型专属内容。通用规范允许的空集合、可选属性和待标定状态沿用原语义。型号选择本类型声明的能力，并提供实际节点、尺寸、接口坐标和标定。构建时验证模板，发布时再验证完整型号定义与模型绑定。 |
| `behavior.ts` | 每类一份实现脚本。在该文件中按行为 ID 组织处理函数，封装设备专属的预检、运动阶段、I/O 处理、完成证据、取消与停稳，以及所需的条件提供者、被动钩子。可在文件内复用函数或类。两个入口使用同一份实现代码，每个设备实例持有独立状态。 |
| `index.ts` | 导入同目录的 `contract.json` 和 `behavior.ts`，向注册表提供类型、兼容修订及工厂。工厂用已解析的实例配置和会话服务创建驱动，暴露该型号和模式支持的动作。工艺顺序由 DSL 决定。 |

**现有函数如何归位。** 举例来说，`HumanCarryMotion` 的吸附搬运阶段归 `human_operator/behavior.ts`，`RotaryIndexMotion` 的带载分度归 `rotary_table/behavior.ts`。机械臂的抓放、交接、工具加工从 `RobotSceneAdapter`、`RobotJobRunner`、`BottleHandoffLine` 和 `RobotProcessingMotion` 等提取设备专属逻辑，集中到 `robot_arm/behavior.ts`。传送带的单机启停调速和场景定位输送均归 `conveyor/behavior.ts`，保留各自的输入与完成语义。升降台的虚拟交接和滑轨的定位分别归入各自脚本。

**共用与场景逻辑的边界。** 关节轨迹、单轴轨迹、逆运动学和 Jolt 约束等共用算法由脚本调用。PLC 通用请求握手、信号注册、工艺调度与资源仲裁保留在运行时。场景继续提供批次、端点连接、共享区域和独立验收目标。例如双臂交接时，机械臂脚本负责当前手臂的动作，装配上下文提供对端实例、相遇点和共享工件的所有权。迁移期间旧文件可转导出新实现，最终以十个类型脚本为设备行为的维护入口。

## 3. 行为覆盖基线

盘点对象为 `apps/public/scene/S01–S12/.generated/scene.bundle.json` 中的设备契约和 DSL 调用。基线共有 **158 个静态调用点、19 种不同的“设备类型＋行为 ID”**，调用点不展开循环。已有候选运行路径的 S01、S02、S04、S06、S07、S11 共使用其中 **16 种**。表中列出这些实际调用，同时标明单扫 DSL 会漏掉的依赖。

| 设备目录 | 现有候选场景中的 DSL 动作 | 还需归集的执行能力及当前来源 |
| --- | --- | --- |
| `robot_arm` | S01/02/06 的 `pick_and_place`、`move_to_pose`；S04 的 `pick_and_handoff`、`place_held_material`、`move_to_pose`；S11 的 `process_material` | 抓放执行器、关节回零、双臂约束移交、工具对准与退位。现分布在 `RobotSceneAdapter`、`templates/robot`、`BottleHandoffLine`、`HandoffMotion`、`RobotProcessingMotion` 等处 |
| `conveyor` | `transport_to_position`、`transport_to_exit`、`stop_conveying`、`release_material` | 单带接触驱动与编码器、整场景具名目标定位、多段联动、停稳和出口回执。保留 `ConveyorTemplate` 与 `PositionTransportAdapter` 各自接受的命令和反馈 |
| `rotary_table` | S11 的 `rotate_to_station` | 从 `RotaryIndexMotion` 与分度场景装配提取带载分度、转角测量、保持、制停及到位证据 |
| `machine_tool` | S06 的 `machine_material` | 从 `MachineToolAdapter` 归集工位占用、机器人退位、加工周期和工件状态提交；批次准入与整盘验收归场景 |
| `material_source_station` | 六个候选场景的供料通过环境准入 | 归集供料的可用状态、容量、在位支承与交付证据；环境负责何时接纳下一个登记物料。保留 `produce_material` 等既有声明及其接入状态 |
| `workpiece`（含托盘） | 工件与托盘均由搬运、输送、加工设备或物理接触驱动 | 工件按型号配置抓取口、加工口与加工性质。托盘按型号配置支承面和槽位。引擎维护载荷跟随、槽位占用和装卸确认，整盘交付由场景接收方出具回执 |
| `linear_rail` | S07 的 `move_to_location` | `LinearRailSceneAdapter` 还支持 `move_to_position`、`stop_motion`；目标由场景点位解析，并校验行程 |
| `lift_table` | S07 的 `lift_to_location`、`accept_material`、`release_material` | 保留 `lift_to_level`、`hold_lift`、`transfer_material` 及短距离虚拟交接。滑轨搭载升降台时共用安装关系与承载状态 |
| `storage_rack` | S07 通过升降台交接使用货架 | 保留 `StorageRackRuntime` 按请求预留、提交、取消与占用查询；实物交接成功后才更新格位 |
| `human_operator` | S11 的 `carry_material` | 从 `HumanCarryMotion` 归集接近、吸附、移动、放置和撤回；人物模型、掌面和渲染关节作为实例绑定 |

迁移清单同时覆盖以下入口。

- **历史声明基线。** 十二个旧场景按原类型和行为 ID 去重有 76 项声明，其中十个目标类型原有 66 项、旧 `workpiece_carrier` 有 7 项，另有 3 项来自实验工站。该统计用于核对迁移前后的能力与数据。实施时由脚本生成逐项对照表，记录旧声明、调用位置、运行模式、旧实现、目标模块和验证用例。主动调用、内部步骤、被动服务、持续反馈与待接入声明分别标明。清单不能用“找到同名函数”判定完成。
- **历史实验。** S05、S08、S09、S12 使用实验 `processing_station.clamp/process_material/unclamp`。保留原兼容路径和对应诊断；S06 的机床加工、S11 的持枪加工需要不同的动作签名和现场证据。S03、S10 虽调用部分相同动作，仍按其各自的准备与验收状态记录。

### 3.1 声明与实际调用的逐项对照

下表冻结十二个发布包中按“原设备类型＋行为 ID”去重的 76 项。中列记录已接入的六个候选场景实际调用的 16 项。右列含其他场景调用、单设备或服务能力、被动观测、以及目前仅有声明的行为。保留名称的同时，逐型号核对修订、签名、前置／持续／完成条件、支持模式、实现状态及原有报错。

| 原设备类型 | 六个候选场景实际调用 | 同类型的其余发布声明 |
| --- | --- | --- |
| `robot_arm` | `move_to_pose`、`pick_and_handoff`、`pick_and_place`、`place_held_material`、`process_material` | `execute_job`、`grip`、`hold_motion`、`pause_pick_intake`、`publish_robot_state`、`release`、`resume_motion`、`resume_pick_intake`、`set_output`、`wait_signal`、`wait_time` |
| `conveyor` | `release_material`、`stop_conveying`、`transport_to_exit`、`transport_to_position` | `accept_material`、`advance_to_next_stop_point`、`meter_release`、`move_by_distance`、`publish_drive_feedback`、`reverse_conveying`、`set_speed`、`start_conveying`、`zone_accumulation` |
| `rotary_table` | `rotate_to_station` | `accept_material`、`convey_on_deck`、`hold_rotation`、`publish_turntable_state`、`release_material`、`resume_rotation` |
| `machine_tool` | `machine_material` | — |
| `material_source_station` | — | `pause_production`、`present_material`、`produce_material`、`publish_source_state`、`resume_production`、`schedule_production_cycle` |
| `workpiece` | — | `be_carried`、`be_conveyed`、`be_picked`、`be_placed`、`be_released`、`publish_material_state`、`respond_to_physics` |
| `linear_rail` | `move_to_location` | `move_to_position`、`stop_motion` |
| `lift_table` | `accept_material`、`lift_to_location`、`release_material` | `hold_lift`、`lift_to_level`、`transfer_material` |
| `storage_rack` | — | `cancel_cell_reservation`、`publish_storage_state`、`query_cell_state`、`release_from_cell`、`reserve_cell`、`store_to_cell` |
| `human_operator` | `carry_material` | — |
| `workpiece_carrier` | — | `be_transported_loaded`、`cancel_carrier_reservation`、`carry_material`、`confirm_load`、`publish_carrier_state`、`release_material`、`reserve_carrier_slot` |
| `processing_station` | — | `clamp`、`process_material`、`unclamp` |

### 3.2 场景包清单以外的入口

| 来源 | 还需保留的内容 |
| --- | --- |
| `src/contracts/robot-command.ts` | 顶层六个命令为 `move_joints`、`move_to_pose`、`execute_job`、`pick_and_place`、`grip`、`release`。内部七种步骤为 `move_joints`、`move_to_pose`、`grip`、`release`、`wait_time`、`wait_signal`、`set_output`。同名命令与步骤分别校验其载荷、次序和可用入口。 |
| 公共型号包与工作台模板 | 对照 `public/modles/*/schema.json` 与 `public/catalog/examples/*.json` 保留型号签名和允许的 I/O。保留 `src/domain/catalog.ts` 产生的预览观测 `observe_material` 与旧 `observe_slots`，后者映射到物料的承载观测。 |
| 参考契约 | `test1/dsl_new/asset_contracts/assets/lift_transport.json` 另声明 `raise_transfer_chains`、`lower_transfer_chains`、`resume_lift`，迁移后保留原声明状态。历史归档中的 `run`、`transport_carrier_to`、`index_to_angle` 等旧名称随对应原始资料及既有迁移路径保留。 |
| 信号与隐式服务 | 输送带保留 `runTag`、`speedTag` 等 I/O。机械臂保留 `enableTag`、`pause_pick`、`reset`、请求号及接受／完成／故障反馈的写入权与关联规则。货架预留／提交／取消、工件吸附和释放、载荷随盘和供收料回执按既有调用点逐项对照。 |

按上述发布场景、三个独立模型包、四个公共契约示例、参考设备模板、示意观测和机械臂命令取并集，共有 **82 个不同的旧类型与 ID 组合**（76＋3 个升降声明＋2 个示意观测＋1 个 `move_joints`）。归档协议、底层方法和 PLC 信号另外核验。实施时按“原来源／型号修订／调用模式／原 ID”生成映射，保留每一项的声明、实现或兼容去向。遇到同名动作跨类型或同修订不同型号时分别比对，避免静默覆盖。

### 3.3 逐设备行为契约

[设备行为、判定条件与信号接口附表](015-device-behavior-contract-matrix.md)是十类设备编写 `contract.json` 和 `behavior.ts` 时的逐项依据。每行同时给出适用来源、前置与持续条件、完成证据、输入及输出信号。先选择型号和运行模式，再采用该行的整套约定。普通物料和带承载属性的托盘通过被动响应与状态观测参与工艺。

例如 S11 的人物搬运读取 `execute`、`request_id`，只有物料已到目标、得到支承、人物空手撤回，并取得同一请求的移交回执才完成。该行为声明的输出为 `accepted`、`busy`、`done`、`result_id`、`error`、`holding_material`。附表对其他行为按同一口径列示，并保留旧托盘、实验工站、独立模型与历史示例的协议差异。

## 4. 契约模板与运行绑定

1. **模板描述类型，实例补齐型号。** 类型模板以 [设备契约](../../../test1/docs/设备契约.md) 为准，包含顶层元数据、参数约束、空间接口、信号端口、行为、运行条件与执行声明。模板内列出需要模型提供的绑定。生成可导入 DeviceSpec 时再填写真实模型引用、节点、接口坐标及相应标定。已校准的单设备 UR10、场景焊接机械臂可以共享类型基础，同时保留各自工具和执行能力。
2. **按行为声明证据。** 每项有限动作列出参数或载荷、命令与反馈信号、前置条件、执行中须保持的条件、完成检查。凡涉及端点或工具的动作，声明所需接口角色与来源，准备阶段在选定实例上解析。空间端口负责位置和兼容性；条件通过 [统一条件表达式](../../../test1/docs/统一条件表达式.md) 的参数、信号、观测、授权或请求记录求值。兼容既有原生条件时必须登记真实提供者。未绑定条件保持未知，有限动作的完成须匹配本次请求及实际结束证据。
3. **显式选择能力。** 以设备类型、模板修订、能力和执行模式定位实现，保留基础格式版本 `contract_version`、设备修订 `version` 和命令协议版本的各自含义。当前 S04 与 S11 都使用 `standard.robot_arm@1.1.0`，后者多了 `torch` 和 `process_material`；S11 与 S12 的同版本转台声明也不同。迁移时按原包来源和契约内容指纹建立映射，分别生成确定的能力组合。有歧义或不可执行的调用在准备时报告设备、行为和缺失的绑定。
4. **按实例和会话创建状态。** 注册表保存工厂及静态描述。每次装配按 `instanceId` 和 `runId` 创建驱动，注入物理接口、点位、信号、条件与资源服务。沿用 `DeviceActionPort` 的预检、提交、固定步进、取消及回执协议。独立实验通过其既有命令接口使用设备库。重复请求、回执串用、停机后误交付和跨实例共享抓持状态纳入回归。

### 4.1 物料的可选承载属性

拟在物料类型模板的 `type_specific_contract` 下增加可选的 `carrying` 块。普通工件可省略，托盘型号填写。物料身份、几何和自身质量仍使用现有物料字段，承载属性独立于可加工、可抓取等其他性质。

| 所属层次 | 内容 | 由谁使用或更新 |
| --- | --- | --- |
| 型号契约 | 支承面、具名槽位及其在托盘局部坐标系下的位置。按型号需要声明最大载荷、槽位布局或分层支承 | 引擎校验引用、单位与已声明的限值，并按托盘当前位姿计算放置目标。槽位可以来自具名模型节点或显式局部坐标 |
| 场景初态 | 每盘的实例 ID、初始空盘或预装清单，以及预装工件 ID 到原槽位的对应关系 | 场景编译器按批次展开，每盘和每件工件分别保有身份 |
| 运行状态 | 槽位预留、实际占用、工件当前支承者、载荷绑定及装卸回执 | 搬运设备提交装卸请求；引擎在放置、抓取或释放得到物理确认后更新。输送带运送托盘时，已绑定工件随盘移动 |

**兼容旧托盘。** 导入旧 `workpiece_carrier` 契约时，将其归一为带承载属性的 `workpiece`。保留原始包、模板引用、实例 ID、槽位名、局部位姿、预制体初始清单及物料 ID。旧场景中的 `P01.slot1` 等引用仍解析到原托盘的同一槽位。

旧契约的 7 项声明保留原类型和可调度标记，供历史数据校验与追溯。`reserve_carrier_slot`、`cancel_carrier_reservation` 和 `confirm_load` 对应交接过程中的预留、取消和装载确认；`carry_material`、`release_material` 和 `be_transported_loaded` 对应支承、解绑和随盘运动；`publish_carrier_state` 对应状态观测。现有已发布 DSL 对旧托盘类型的直接调用为零。新模板通过承载属性、交接事件及观测表达这些语义，可调度动作仍属于实际执行搬运或输送的设备。

### 4.2 从注册、加载到完成的文件链路

以下路径相对 `apps/`。`src/devices/` 下的文件为拟建入口，其余列出的文件均为当前源码。**注册**建立类型与工厂的对应关系；**加载行为**发生在准备会话时，建立“实例 ID＋行为 ID”到本次驱动的绑定；**执行**发生在 DSL 工步被调度时。

| 阶段 | 文件与流向 | 输入、输出及校验 |
| --- | --- | --- |
| 1. 登记实现 | 拟建 `src/devices/registry.ts` 静态导入各 `<type>/index.ts`；各工厂导入同目录 `contract.json` 与 `behavior.ts`，对照 `catalog.json` | 登记“类型、修订、运行模式 → 工厂”。检查重复键及清单与实际导出的差异。新型号只能选择其契约声明且有对应实现的可执行动作。 |
| 2. 发布资产 | 单设备经过 `scripts/build-model-catalog.mjs`；场景经过 `scripts/build-scene-catalog.py` 的 `SceneParser.compile`、`scripts/lib/scene_devices.py` 的 `load_scene_devices`、`scene_prefabs.py` 的 `expand_prefabs` 及 `scene_binding_check.py` 的 `validate_inputs` | 将类型模板和型号绑定展开为完整 DeviceSpec。单设备生成型号定义与模型索引；场景从 `process.py` 编译 IR，输出含调用清单、实例和来源摘要的 `.generated/scene.bundle.json`。Python 只消费 JSON 声明，TypeScript 实现由静态注册表关联。 |
| 3A. 单设备导入与加载 | `src/services/PublicModelCatalog.ts` → `src/domain/normalizeDeviceSpec.ts` → 统一契约分支 `normalizeUnifiedDevice.ts`。运行时经 `src/services/RuntimeController.ts` → `src/domain/runtime/compileRuntimeScene.ts` → `src/runtime/engine/RuntimeKernel.ts` → `src/runtime/programs/RuntimeProgramFactory.ts` → `RobotProgram.ts` 或 `ConveyorProgram.ts` | 从工程取得型号定义、实例覆盖与已选物料。当前两个程序在 `src/runtime/templates/registerTemplates.ts` 查模板并创建脚本；迁移后在同一位置经 `devices/registry.ts → <type>/index.ts → behavior.ts` 创建单设备驱动。原有手动信号和机械臂命令继续沿本入口提交。 |
| 3B. 场景导入与加载 | `src/services/PublicSceneCatalog.ts` 的 `importScenePackage` → `SceneRuntimeController.ts` → `prepareScenePackage.ts` → `src/domain/runtime/compileSceneRuntime.ts` → `src/runtime/assembly/SceneRuntimeAssembler.ts` 和相应专用装配器 | 校验模型、场景包与输入文件哈希，编译实例与物理点位。当前使用 `RuntimeFactoryRegistry.ts` 或专用装配器创建驱动；迁移后统一向 `devices/registry.ts` 查询类型工厂。`<type>/index.ts` 接收型号、`instanceId`、`runId` 及物理／点位／资源服务，由本类型的 `behavior.ts` 创建该实例的动作处理器。 |
| 4. 绑定 DSL 工步 | 装配器 → `src/domain/runtime/compileConditions.ts`、`bindDeviceBehavior.ts` → `bindProcess.ts` | 将行为签名、载荷、信号和条件绑定为工步使用的 `ActionBinding`。核对 DSL 中的实例、行为、单位和所需提供者。被动观测和待接入声明保留各自的状态。未来自搭场景也从用户选定的实例、连接和 DSL 形成同样的输入，复用同一组工厂。 |
| 5. 调用与反馈 | `src/runtime/engine/SceneRuntimeProgram.ts` 的 `advance` → `src/runtime/scheduler/ProcessScheduler.ts` → 已绑定驱动的 `prepare` → 提交输入信号 → `submit` → `SceneWorldStepper.ts` | 每步依次执行设备的 `beforePhysics`、共享物理世界的 `step` 和设备的 `afterPhysics`。设备提交信号、观测和带请求身份的反馈；`src/runtime/signals/` 发布快照，调度器在下一步核对持续／完成条件并推进 DSL。取消、停稳确认与资源释放同样经过既有协议。 |

**例：S11 的一次加工。** `R1.process_material` 从工步取得工件、工装、`torch` 和 `weld`。准备时，已有的 `compileIndexedProcessing.ts` 校验工具与物料接口；迁移后的 `IndexedProcessingRuntimeAssembler.ts` 通过 `registry.ts` 把 `R1` 绑定到 `robot_arm/index.ts` 创建的实例。工步触发时，`robot_arm/behavior.ts` 执行接近、对准、停留和退位，按原条件提交加工回执。DSL 收到本次完成证据后，才调度转台的下一次分度。`R1` 的位姿和当前工件由场景注入，同一脚本可以服务其他符合契约的实例。

## 5. 构建、兼容与迁移顺序

| 阶段 | 改动与主要文件 | 完成证据 |
| --- | --- | --- |
| 1. 冻结迁移清单 | 从十二个场景、`public/modles/`、单设备命令 schema 和运行注册点反向建立清单；对照旧类型枚举、声明版本和实际行为 | 158 个静态调用的原始记录可复现，每个调用、内部步骤和隐式服务均有去向，实验与待接入项有独立状态 |
| 2. 建立模板源和发布链 | 以十类设备为目标，同步更新设备契约规范、类型校验与旧托盘导入映射，再接入 `scripts/build-model-catalog.mjs`、`scripts/build-scene-catalog.py`、`scripts/lib/scene_devices.py`。Python、Node 与工作台读取同一套版本化 JSON；TS 函数由静态注册表加载 | 模板＋能力＋型号绑定能生成完整 DeviceSpec，单设备导入器及场景编译器接受相应发布物；同一输入生成一致的结果 |
| 3. 打通最小纵向流程 | 先迁移传送带与工件。让既有单设备实验和场景输送分别从同一设备目录获取实现。用两个独立添加的设备实例、具名入口/出口及短 DSL 验证解析和执行 | 实际工件到达目标并停稳，PLC 回执可追溯；改实例名或摆放后仍按目标解析。端口缺失、方向不兼容或待标定时能指出原因 |
| 4. 按依赖迁移其余行为 | 先接入物料的承载属性并迁移机械臂和机床，回归装载、加工与双臂交接。随后迁移滑轨、升降台和货架，最后迁移人物、转台与工具加工。同步归集各场景使用的供料能力与所需环境接口 | 每迁一组，旧入口先转调新库，比较相同输入下的动作、信号、到位证据与最终工件归属，再移除重复实现 |
| 5. 收敛入口与合并 | `compileRuntimeScene.ts`、`compileSceneRuntime.ts`、单设备模板注册与各 `*RuntimeAssembler.ts` 改为消费设备库。场景保留批次、连接解析、跨设备授权和目标验收 | 入口扫描及覆盖测试通过，执行器均可从对应类型目录找到；完成全量回归后将本分支合入 `main` |

发布时继续提供 `public/modles/<型号>/schema.json`、场景包内 `contracts/` 的完整快照和场景索引。在构建阶段将模板及选定能力物化到包内，依照现有 `contract_ref` 的场景内路径规则编译；记录模板修订、来源摘要和发布文件哈希。独立包导入和整场景准备均消费这份发布结果，模板展开只在构建时做一次。既有项目继续按所存版本与哈希读取，源变化沿用显式重新导入机制。旧独立包的 `conveyor.continuous-contact@1`、`robot.articulated@1`、`robot-command@1` 等引用保留兼容映射。动画预览的 Mock 执行器继续按模拟模式单独登记。

## 6. 合入前的验收

- **契约与组织。** 十个类型目录分别核对 `contract.json`、`behavior.ts` 和 `index.ts`。契约通过通用 DeviceSpec 校验，注册表导出的动作和条件与该型号声明一致。核对单设备与整场景均经工厂进入同一个类型脚本。普通工件、托盘都由物料模板导入，公共资产与场景契约可以追溯到唯一维护源。检验重复注册、签名冲突、悬空端口、输入输出方向或单位错误、缺少已用行为实现、条件提供者缺失和有限动作缺少完成证据。所有可执行项都有测试或真实回放对应。
- **行为零遗漏。** 以第 3 节的逐项清单对比迁移前后：82 个来源限定的类型／ID 均可追溯，158 个静态调用点逐一比对，机器人顶层命令和内部步骤按模式核验。实现阶段对每个已运行路径比较原输入、位置／状态、PLC 回执和最终工件归属，待接入项保留原诊断。任一旧记录缺少去向、行为重名发生覆盖或已用调用缺少处理器，均阻止合并。
- **单设备与组合。** 保留独立输送实验、真实工件刚体和 UR10 抓放。验证同类型两个实例的独立状态、角色兼容与实际物料交接，以及暂停、停止、取消、放弃会话后的约束和资源释放。
- **托盘兼容。** 使用普通工件、空托盘和预装托盘三组样例。普通工件可省略承载属性。新配置与旧托盘格式应得到等价的槽位、所有权和交付结果。重点复验 S01 逐件取走后空盘离场、S02 的 12 个下层位、1 个盖板位和 12 个上层位及其支承顺序，S06 九件加工后各回原槽，以及 S10 旧托盘的显式点位导入。验收时检查取消预留后可再次占用，同一工件在同时刻只有一个承载归属。
- **既有场景。** S01 三盘 36 件并行交付；S02 六盘清单、上下层各 12 件与盖板的原有约束，并复验已覆盖的连续抓放归位；S04 四瓶头尾换手、倒置出带；S06 九件各加工一次并回原槽；S07 单件、三件成功且原四件任务仍报告第四层不可达；S11 四件各两次正向分度、一次加工、一次交付。另对十二个场景做全目录构建，比较原有可运行或阻塞结果。
- **复现。** 在 `apps/` 下运行 `npm run catalog:models`、`npm run catalog:scenes`、`python -B -m unittest discover -s scripts/tests`、`npm run typecheck` 和 `npm test`。检查原有 PLC 信号、梯形图、物理与渲染绑定，并从工作台资产库导入迁移后的单设备及整场景，执行最小自搭流程。

本阶段已完成源代码与场景调用盘点。以上目录、迁移和合并验收均为后续开发事项。

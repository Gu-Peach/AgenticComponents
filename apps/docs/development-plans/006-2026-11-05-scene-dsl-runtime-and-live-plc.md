# 006 场景 DSL、真实资产执行与 PLC 实时模块

日期：2026-11-05。项目根目录：`E:/project/AgenticComponents/apps`。

本文件定义目标方案，并在第13节列出已落地基础与剩余工作。尚未形成十二场景的真实物理运行闭环；不能把包构建、静态模块显示或单元测试当作整场运行证据。

## 1. 目标与交付范围

把`public/scene/S01—S12`从“GLB与工艺声明的文件集合”变成可发现、可校验、可按真实物理反馈运行的场景资产包，并用同一份运行信号驱动PLC模块界面。

四项交付：

1. 受限Python风格DSL编译为工艺控制IR，由场景行为运行器组织设备；设备适配器求解具体动作，统一物理世界执行，观测反馈决定工步推进。
2. 每个场景使用`device/`中的真实实例契约描述整场GLB内的设备、物料及载具，无需拆分输出独立GLB。`process.py`直接解析这些资产符号，不再依赖独立的`batch.json`、`bindings.json`运行入口。
3. 资产库新增“场景”分类，展示十二个场景，支持预检、导入、保存、重开和运行状态提示。
4. PLC面板增加按DSL控制关系组织的设备模块图，显示真实端口、值、质量、请求及工步状态。模块布局参考用户截图的输入/模块/输出形式；不把截图中的外部产品块名或行为当作本项目规范。

本轮不以自动生成完整ST、接真实PLC或工业安全认证为验收条件。模块图是本项目工艺运行与信号的可视化投影；现有ST文本保留为独立页签，不能暗示其已经执行。

## 2. 已核实的基础与缺口

### 2.1 代码证据

| 当前位置 | 已有能力 | 必须补齐的部分 |
| --- | --- | --- |
| [RuntimeKernel](../../src/runtime/engine/RuntimeKernel.ts) | 工厂创建ConveyorProgram或RobotProgram；固定1/60秒step；快照及单机器人命令入口 | 当前不是任意多设备场景调度器，program类型仍是两个具体程序的联合 |
| [ConveyorProgram](../../src/runtime/programs/ConveyorProgram.ts) | beforePhysics→physics.step→实际位置/支承观察→afterPhysics发布 | 持有单subject与本地世界，不能把每个实例step原样拼到共享世界 |
| [RobotProgram](../../src/runtime/programs/RobotProgram.ts) | 校验RobotCommand，规划步骤，维护请求账本，执行物理抓放 | 目标物料及放置参数有单实验会话假设；端口表部分硬编码 |
| [PhysicsPort](../../src/contracts/physics.ts) | 表面速度、刚体读取、运动学工具、抓取约束 | setSurfaceSpeed/readMaterial仍带单目标语义；需要多body、多surface、多工具寻址 |
| [Jolt后端](../../src/runtime/physics/jolt/JoltPhysicsBackend.ts)及BodyRegistry/ConveyorContacts/GraspConstraints | 刚体、接触输送、抓放约束基础 | 场景级生命周期、托盘载荷、多机器人碰撞及跨设备支承交接 |
| [SignalRegistry](../../src/runtime/engine/SignalRegistry.ts) | 端口类型/范围检查、待提交输入、publish、valid/tick/writer | 默认输送端口表、单实例表；写入者标识目前偏manual/engine，缺少全场景身份及质量协议 |
| [ActionGateway](../../src/runtime/engine/ActionGateway.ts) | 单主体输送请求、支承/到达/掉落/超时判定 | 统一跨设备行为入口、资源集原子授权、重复请求及取消/停止关联 |
| [SimulationSession](../../src/runtime/engine/SimulationSession.ts) | 启动、暂停、恢复、step、stop | stop当前调用底层立即销毁式逻辑，场景运行需区分受控停止、已停稳和销毁 |
| [compileDeclarativeScene](../../src/domain/runtime/compileDeclarativeScene.ts) | 已放入项目的契约1.3传送带+物料编译 | 名称里的Declarative不表示已经解析process.py；当前有水平输送面与单件实验约束 |
| [模板注册](../../src/devices/registry.ts) | 注册输送与机械臂模板 | 升降、旋转、仓储服务、载具服务及加工设备不能因存在JSON就视为已有执行器 |
| [AssetPanel](../../src/features/catalog/AssetPanel.tsx)、[build-model-catalog](../../scripts/build-model-catalog.mjs) | 单设备目录与设备/物料载具筛选 | 目录生成器扫描`public/modles`，尚无场景包导入事务 |
| [PlcPanel](../../src/features/plc/PlcPanel.tsx) | ST编辑、导入导出，运行按钮明确未接入 | 现有内部DeviceDefinition.interfaces是规范化信号列表的历史字段名，不等于原始DeviceSpec空间interfaces；新场景模块直接读取contract.signal_ports，实时快照仍待接入 |

`test1/dsl_new`提供0.3静态前端、契约绑定检查和十二份工艺声明，可作为编译语义与反例测试依据，不能当成已经存在的浏览器执行器。保留单设备实验作为回归，避免为了场景化破坏现成闭环。

### 2.2 场景文件盘点

以下统计直接读取当前GLB的JSON段，不是运行或几何标定结论。十二份GLB均为0个skins、0个animations；节点变换仍可能用于关节驱动，是否具备可分离的关节链须另查。

| 场景 | 当前GLB相对目录 | 节点数 | 网格数 |
| --- | --- | ---: | ---: |
| S01 | assembly_order_index/assembly_order_index.glb | 488 | 285 |
| S02 | assmbly_depalletizing/assmbly_depalletizing.glb | 995 | 486 |
| S03 | Closed Conveyor Loop/Closed Conveyor Loop.glb | 656 | 202 |
| S04 | Coordinated Robotic Transfer Unit/Coordinated Robotic Transfer Unit.glb | 208 | 123 |
| S05 | Deburring with Two Robots/Deburring with Two Robots.glb | 423 | 333 |
| S06 | Indexing Table layout/Indexing Table layout.glb | 928 | 618 |
| S07 | Intelligent Storage and Logistics Line/Intelligent Storage and Logistics Line.glb | 385 | 330 |
| S08 | L-shaped Automated Machining Cell/L-shaped Automated Machining Cell.glb | 429 | 275 |
| S09 | Machine tending/Machine tending.glb | 655 | 530 |
| S10 | Robot Palletizing Workstation/Robot Palletizing Workstation.glb | 385 | 255 |
| S11 | Robot Welding cell/Robot Welding cell.glb | 991 | 868 |
| S12 | Turntable Work Cell/Turntable Work Cell.glb | 809 | 446 |

本次盘点没有发现任何场景device目录下的JSON定义；S01/device已建立但为空。旧batch/bindings仍存在。S01包含Conveyor(1)—Conveyor(4)等节点组；不能仅靠名称或出现顺序认定R1/R2/C1/C2/C3，必须结合空间、输送面和用户场景语义逐个核验。

## 3. 总体执行链路

```text
场景包：整场GLB + device实例契约 + process.py + 独立验收目标
  → 资产/节点/类型/几何预检
  → DSL受限语法解析 → ProcessIR
  → 契约解析、条件/信号/资源/载荷绑定 → BoundProcess
  → 场景工艺调度器（顺序、并行、分支、循环、激活/请求身份）
  → 统一ActionGateway → 各设备行为适配器
  → 运动学/轨迹/输送/夹持求解 → 一份PhysicsCommandBuffer
  → 场景Jolt世界推进一次
  → 实际位姿、速度、接触、支承与约束观测
  → 条件求值、请求结果、SignalRegistry、SceneRuntimeSnapshot
  → 下一工步 + 场景渲染 + PLC模块显示 + 证据日志
```

“行为引擎求解后交物理引擎执行”的理解基本正确，但它是持续闭环，不是一次性把整段动画交给物理引擎。调度器决定哪个行为可以申请执行；设备适配器产生受约束的命令；物理引擎不解释DSL，也不决定工艺完成。完成由行为契约结合实际观测确认。

ProcessIR可以呈现为工艺行为树，但不能直接套用每帧重新执行叶子的游戏行为树语义。节点激活有持久状态与唯一身份；重复tick不能重复发送抓取、生产或释放命令。已有机器人内部RobotJobRunner只负责设备内子动作，不承担整个场景的分支和资源调度。

核心不变量：一个场景运行对应一个runId、一份注册表、一套资源仲裁和一个物理世界；每个逻辑tick恰好一次物理推进。设备不能各自step共享世界，也不能在单设备结束时dispose整个世界。

## 4. 场景包与device真实绑定

### 4.1 目标目录及单一信息来源

```text
public/scene/
  index.json                         # 构建生成的场景目录
  S01/
    scene.json                       # 包入口：版本、GLB/预览图/工艺/设备路径、哈希
    process.py                       # 控制关系及有限生产任务声明
    task-spec.json                   # 独立验收目标
    device/
      R1.json  R2.json
      C1.json  C2.json  C3.json
      P01.json ...                  # 被动载具实例或显式实例生成定义
      M01_1.json ...                # 物料实例或有边界的生成定义
    assembly_order_index/
      assembly_order_index.glb      # 保留现有整场GLB，不拆分导出
      image.png
    .generated/process.ir.json       # 可选构建产物，带源哈希，不能手工维护
```

scene.json只描述包结构和版本，不存行为步骤，也不变成另一份bindings。device文件是实例绑定唯一入口；可引用共享、锁定版本的行为模板，但必须显式提供本场景的几何、节点及能力配置，不能凭模板名自动继承“已实现”。

建议新增`SceneDeviceSpec`实例封装，兼容现有DeviceSpec规范字段：instanceId、contractRef/version、参数、behavior实现引用、signal_ports、sceneAssetRef/nodeBinding、type_specific_contract、calibration及初始对象关系。共享模板定义与实例覆盖的合并顺序固定，覆盖不得改变端口类型、行为参数或结束语义而不升级契约版本。

引用`public/modles/robot_UR10`时只复用已核验的求解器/协议形状，不能把该模型的轴、尺寸、TCP或模型哈希套到场景中的另一台机械臂。

### 4.2 不拆GLB的节点与物理绑定

每个device需要声明：

- GLB资源哈希、场景内稳定节点选择器、语义角色。选择器优先使用作者设置的唯一semanticId；旧模型可暂用完整路径+节点索引+资源哈希，节点重命名或哈希变化立即失效。模糊名称或“第几个同名节点”不得静默匹配。
- 实例根、关节/link节点、rest transform、轴/限位/父子关系、TCP、抓取与放置坐标系。GLB无动画不自动等于可驱动；若机械臂是不可分离的单网格，需要上游重新分组/导出原GLB，不能靠schema把一块网格伪造成独立关节。
- 物理body与shape、质量/摩擦/恢复系数、motionType、碰撞过滤、输送surface、观测区域和资源区。渲染网格不自动等于有效碰撞体；静态复杂场景可用离线碰撞代理，动态物体用后端支持的凸形/复合体。
- 托盘与槽位、初始装载、物料身份、动态支承与夹持关系。实例克隆必须有独立ID和物理body，可共享原GLB的几何/材质，不能把多个物料当成同一body。
- 世界、场景、设备、body与tool之间的变换规则，显式单位和轴向；拒绝未支持的负缩放/非均匀缩放。运行变换由渲染桥写入实例克隆，不反写静态schema。

整体GLB加载一次。绑定器为每个设备引用其子树及物理部件；同一运动节点只能有一个运行所有者，禁止渲染动画和物理结果同时写同一变换。装饰节点可不建行为，但不能漏掉会阻挡工件或机器人运动的碰撞几何。

S01首先形成可审核的绑定表：GLB节点路径/索引、DSL符号、设备类型、body/link、工作区、标定状态和证据。当前不能预填“Conveyor(1)=C1”等未经确认的对应关系。

### 4.3 取消batch/bindings后信息放在哪里

取消两份独立运行输入，不等于删除订单、身份、位置和信号映射。

| 原信息 | 新的唯一归属 |
| --- | --- |
| 实例/参数/信号/节点/物理区域/载荷适配 | 对应device实例契约 |
| 初始槽位装载、物料类别、有限物料实例 | device的initial_inventory/实例生成声明 |
| 本次处理哪些对象、数量、加工要求、返工要求 | process中的有限production声明；不得写逐步到站路线 |
| 身份到DINT映射、符号表、条件绑定、运行锁 | 编译生成的BoundProcess及运行登记表，不再手写bindings |
| 位置/节距/工具标定 | device.calibration，未知值不补默认成功值 |
| 外部供料、接盘、下游移除 | 有明确物理/交接规则的场景环境服务声明，纳入scene包与运行日志 |
| 独立终态及质量目标 | task-spec.json，保留独立于流程的验收 |

为避免含糊，建议在实现阶段升级到`ac-declarative/0.4`，只增加包与任务绑定入口；0.3保留迁移工具，不在运行时同时读两套来源。下例为拟新增语法，不是当前前端已支持代码：

```python
with process("S01", version="ac-declarative/0.4",
             devices="./device",
             task=production(carriers=("P01", "P02", "P03")),
             goal="./task-spec.json"):
    with repeat("line_cycles", count=task.pallet_count + 2):
        with seq("line_cycle"):
            invoke("advance", C1, "move_by_distance",
                   distance_m=calibration(C1, "pitch_m"))
            with par("station_work", join="all"):
                # 工位子树仍按真实契约行为组织，不执行任意Python函数。
                ...
```

production只接受有界的carrier/material/order选择及需求字段；`task`是编译生成的只读任务命名空间。设备符号从device目录声明的唯一instanceId解析，禁止Python import、eval或执行process.py。上述省略号仅用于文档缩略，正式DSL必须有完整子树。

对于S07库位、S09机床订单、S05返工等，production使用有类型的orders记录；运行数量从冻结实例清单派生。S01视觉上只有一盘时，要明确另两盘是外部缓冲区真实实例还是受控生成实例，不能凭DSL循环虚构出三盘物料。

迁移步骤：提取旧数据→生成device与production→对比身份/数量/来源/目标/配方和条件→双前端输出语义等价IR→新入口验证通过→停用旧文件加载。旧文件可归档供研究复现，但不作为隐含回退源。

## 5. DSL编译和场景行为运行器

### 5.1 编译阶段

1. 校验包路径、哈希、设备版本、GLB节点、生产清单和独立目标。
2. 解析受限Python风格语法，生成带source span、nodeId的ProcessIR；主方案为构建期Python AST前端输出JSON，浏览器不执行Python。编辑后需通过明确的本地/服务编译通道重编译，禁止运行旧哈希IR。
3. 解析设备/集合/标定/订单符号，验证有界循环、作用域、筛选字段、参数类型、单位、范围与行为适用配置。
4. 自动导入前置/持续/结束条件及命令协议、载荷编码、资源需求、停止规则和超时；条件自然语言说明不能被当作可执行表达式。
5. 生成BoundProcess、请求/对象登记、只读模块拓扑和依赖锁。声明存在、适配已实现、标定通过、可执行四种状态分开报告。

只支持明确的八类控制节点：seq/par/branch/repeat/invoke/delay/with-control/fail。不重新加入wait_for。库存有效性、外部交接及独立验收属于自动生命周期；它们仍须有可执行提供者，不能从脚本里消失后就被省略。

### 5.2 执行语义

- seq仅在前一节点有效完成并清理后推进；par产生并行候选，受资源与碰撞区互锁约束，join=all。
- repeat冻结成员及顺序，建立iterationPath；未知库存阻塞而非空集合。空集合可以跳过执行但不能跳过静态校验。
- branch保留exclusive/ordered及三值逻辑；业务条件选择不替代行为固有前后检查。
- invoke状态至少包含pending/precondition_wait/accepted/running/succeeded/failed/cancelling/attention_required；不同阶段有期限。
- 仲裁先核查有效候选，再原子授予所需资源。不得先占住设备等另一个需要同设备的动作产生条件；授权依赖不能形成自锁。保留实际物料占用，不能把软件锁释放等同于物料离开。
- 请求身份由runId+activationId+instanceId+序号组成；done/result_id匹配已接受请求才有效。复合动作内子动作不生成重复外部请求。
- 失败取消par兄弟分支，停止新入场；已发生的物料交接保留。未知停止进入attention_required，不能伪造成功或立即释放持有物。
- process退出后运行独立目标监测；循环走完不代表最后一盘已实际移走。

共享工具/工位的资源持有跨哪些子动作必须明确，例如抓取到退位的运动区授权，不得仅因为每个invoke分别互斥就声称整段协作安全。存在饥饿/循环等待时输出持有者、请求者及阻塞图，不能靠固定延迟掩盖。

## 6. 多设备物理与行为适配

### 6.1 固定时钟分阶段

每个逻辑tick使用统一阶段：

1. 读取上一个已完成物理步的一致快照。
2. 归并请求结果，检查持续条件、故障、取消和超时。
3. 计算控制树可执行候选，完成前置求值与原子资源仲裁。
4. 各设备求解器生成命令，校验单writer并统一提交。
5. Jolt推进一次固定步长；内部子步由物理后端统一管理，设备不得再次推进。
6. 读取所有body/contact/grasp状态，更新条件与信号，发布一个带tick的不可变快照；后继最早下一逻辑tick提交。

先拆出RobotProgram/ConveyorProgram中的beforePhysics、observe/afterPhysics、disposeDevice；场景层独占stepWorld与disposeWorld。兼容包装器继续提供旧单设备实验API。禁止“启动N个SimulationSession再轮流step”作为场景实现。

### 6.2 必需接口调整

- PhysicsPort扩展为setSurfaceSpeed(surfaceId, speed)、readBody(bodyId)、hasSupport(bodyId, supportId)、setKinematicTarget(bodyId, pose)、create/removeConstraint、stepWorld。兼容入口必须显式绑定唯一目标，不能猜第一个body。
- 支持多个运动学工具与多对抓取约束，约束创建前检查实际接近、相对速度、载荷、工具容量与目标身份，释放后观察支承。
- 托盘、物料是独立刚体/合法约束关系；堆叠、摩擦及载荷质心要验证。输送面通过接触驱动物料，禁止直接把物料位置插值到终点。
- 关节运动学/轨迹可复用已有求解器，但每台机器人独立状态，求解结果经过限位/碰撞策略后才能提交。运动学工具并不意味着已经具备全关节动力学或自动避障，应明确支持范围。
- 升降和旋转使用真实运动学支承体，验证接触载荷随动；不能只改渲染节点然后写到位信号。
- 仓储柜主要承担静态碰撞、库位占用和服务事务；真正搬运由机械臂/运输机构完成。托盘与物料不增加虚假自主驱动。
- 加工设备的物理范围明确为夹具/支承/加工状态及配方证据。若不模拟材料去除或焊缝，应在能力中说明；仅等待配方时长不能宣称几何加工质量已验证。实验契约未规范化前禁止标准执行准入。

### 6.3 连续驱动与有限输送

start_conveying的持续状态、transport_to_exit的到达、release_material的下游接收、stop_conveying的实际停止是不同事件，不能互换Done含义。

move_by_distance需要实现目标距离输入、每次请求独立编码器基准、制动模型、容差、实际速度及载荷位置共同确认。它已在研究契约中声明，不等于当前Conveyor_aankws后端已支持。S01/S02共同节距无标定时不可运行；编码器达到距离而载荷打滑应失败或阻塞，不能成功。

### 6.4 环境服务及停止

供料、移除和换盘是显式环境执行器：声明入口/出口、有限库存、容量、物理生成/移除时机和回执。只能在真实到位、支承及交接成立后移除对象，并记录主体与runId；不能由PLC界面或完成计数直接删除物料。

区分Pause（冻结仿真时钟）、受控Stop（停止新命令并继续步进至设备停稳）、Reset（经确认重建初态和新runId）、Dispose（释放世界）。用户停止后“按钮变灰”不等于设备已安全停止。热编辑使BoundProcess失效，必须重编译，不能静默改变运行中的契约或目标。

## 7. 十二场景绑定与验收要点

| 场景 | 必须落实的真实绑定与运行证据 |
| --- | --- |
| S01 | R1/R2与主线/两出料线角色核对；三盘十二件；共同节距和制动；第二、三拍存在两机器人实际动作时间重叠；取料时主线停稳 |
| S02 | 三工位/三机器人/各自出料线；三盘成组填充与排空；每组最多三盘，组间全部空盘真实移出；不声称空闲工位自适应调度 |
| S03 | 闭环的真实输送路径、接触面及交接区；不能用直线实验适配器把环路近似成瞬移路径 |
| S04 | 上料、主输送、下料的流水重叠；单容量与共享位置仲裁；物料源身份正确 |
| S05 | 共用返回线、两机器人、装夹与去毛刺配方；返工件执行次数由原目标独立核对 |
| S06 | 转台轴、角度零位、支承和机器人退位；到位与停稳后才能抓取，空台回转也有实际证据 |
| S07 | 双升降台层高与上下限、搬运机构可达、库位真实位置/容量/预留与确认；禁止货架自己搬运 |
| S08 | 单加工工位夹具/上下料/配方完成与松夹，前后输送流水 |
| S09 | 双机加工并行、单机器人原子互斥服务、共享出口无饥饿与错主体完成 |
| S10 | 三盘各四件、槽位唯一、空盘进入/满盘移走真实确认；无物料丢失或重复计数 |
| S11 | 焊接配方/装夹与转台；F1若为共用装卸位置，单独建环境交接服务，不能拿物料源能力冒充Sink |
| S12 | A面加工及松夹完成后转位交接，再进入B面；两侧资源和转台互锁；每件工序记录完整 |

所有场景必须先产出设备绑定清单、支持能力列表及剩余blockers。目录可展示未完成场景，但运行按钮仅在包、契约、适配和标定均通过时开启。十二场景“可见”不能替代十二场景“可运行”。

## 8. 资产库场景分类与导入

新增SceneCatalogEntry，不把整场景伪装成一个普通DeviceDefinition。资产库显示“全部资产 / 设备 / 物料与载具 / 场景”，场景卡片显示预览、名称、设备/对象数量和预检状态。

新增build-scene-catalog.mjs扫描scene.json，生成public/scene/index.json；保留模型目录原有modles拼写，避免顺手改目录导致旧资源失效。路径含空格须按段编码，拒绝越界路径，固定资源哈希。

导入流程：预览→包预检→原子加入项目→创建场景实例命名空间→加载一次GLB并建立device索引→显示待标定/可运行结果。失败回滚本次导入，禁止半套设备残留。

同一场景可导入两次，但所有instance/body/signal/request前缀必须隔离，例如sceneInstance/S01/R1/enableTag。工程中已有未保存编辑不能被场景卡片双击直接覆盖。场景包源内容与项目实例覆盖分开保存；运行状态不写回public资源或静态工程。

工程保存应锁定scene版本、GLB/设备/DSL哈希、实例覆盖、生产任务与目标引用；重开后重建索引并校验。缺资源或版本变化时提供可读诊断，不用另一版本悄悄代替。

## 9. PLC模块图与真实信号

### 9.1 两种关系不能混成一条线

由BoundProcess构建`PlcGraphModel`：

- 设备接口块：一设备实例一个运行信号身份，左输入、右输出，显示端口名、PLC类型、单位、逻辑地址、当前值和质量。
- 工艺调用节点：引用设备块及behaviorId、DSL nodeId、iterationPath，显示激活、阻塞、执行、完成或失败。
- 控制依赖边：seq先后、par分叉/汇合、branch选择、repeat边界；来源于IR，用单独线型/图例表示。
- 信号连接边：只为真实声明的端口绑定/生成连接绘制；不能把“动作A先于B”画成设备A.Done硬连设备B.Execute。

同一设备在多个工步出现时，调用节点引用同一个信号块，不创建重复控制器或第二份状态。模块端口取自本次使用的行为输入/输出、条件依赖、握手、停止/故障接口的并集；未使用端口可折叠，缺失端口不得自动伪造。

“请求、条件、结果”等调度状态可以显示在模块内部，但必须标为运行器元数据；不能给不存在的BOOL端口命名并当作设备信号输出。空间interfaces不参加信号模块生成。

### 9.2 信号注册、采样与显示

建议快照字段：

```text
sceneInstanceId / runId / instanceId / portId
type / unit / direction / logicalAddress
value: scalar | null
quality: unknown | good | stale | invalid | disconnected
tick / timestamp / writer / requestId / activationId
source: command | device_feedback | derived_observation
```

正式字段以类型设计为准，不能要求现有RuntimeSignal已经具备这些字段。Unknown显示“—/未知”，不能默认为False或0。初始化输入仅在真实提交了设备初始化命令时显示该值；输出在有效观测发布后才good。

设备输入只由有授权的命令网关写，输出只由对应适配器/观测提供者发布；UI只订阅不可变快照，不写变量制造动画。派生事实必须有来源表达式、主体和有效tick，不能与直接传感反馈混淆。

每次变化记录旧值、新值、质量、tick、请求和来源；面板高亮基于真实变化事件。运行tick保持固定，UI可合并为每100ms左右刷新，但请求/结果边沿必须进入完整事件日志，不能因节流丢失。暂停时显示冻结tick；断开、重启和过期样本明确标记，不保留旧run的绿色Done。

面板布局沿用现有深色工作台：顶部“模块图 / 工艺 / ST文本 / 信号日志”，中间设备模块及分组工步，侧栏查看端口来源/请求/DSL位置。提供缩放、定位当前步骤、按设备筛选；选中模块可定位场景设备，反向选择设备也定位模块。

运行前已能显示静态拓扑与端口，但值应未知；未接入设备显示未绑定/不支持。PLC硬件地址未配置时只显示逻辑路径，不猜测%I/%Q。ST页仍标识未执行，除非后续单独实现并验证ST后端。

## 10. 拟修改文件与职责

下列新增名称是实施建议，实际提交应保持领域边界，不把全部状态塞入RuntimeKernel或WorkspaceClient。

| 位置 | 工作 |
| --- | --- |
| `src/contracts/scene-package.ts`、`process-ir.ts`、`scene-runtime.ts` | 场景包、device实例封装、IR/BoundProcess、运行快照及错误类型 |
| `scripts/compile-scene-process.*`、`build-scene-catalog.mjs` | 受限DSL构建编译、资源/哈希校验、目录与IR产物；禁止任意源码执行 |
| `src/domain/runtime/compileScenePackage.ts`、`bindProcess.ts` | GLB/node/device解析、条件/资源/载荷绑定、能力诊断 |
| `src/runtime/engine/SceneRuntimeProgram.ts`、`ProcessScheduler.ts` | 多设备生命周期、控制树激活、统一tick、资源仲裁 |
| `RuntimeKernel.ts`、`RuntimeProgramFactory.ts`、`SimulationSession.ts` | 支持场景程序，保留单设备兼容入口，分离停止与销毁 |
| `SignalRegistry.ts`、`ActionGateway.ts`、`RequestLedger.ts` | 多实例寻址、单writer、快照质量、请求/结果关联与证据日志 |
| `src/runtime/templates/*`、`programs/*` | 拆分before/after物理阶段；新增所需设备适配与停止协议 |
| `src/contracts/physics.ts`、`runtime/physics/jolt/*` | 多body/surface/tool寻址、统一世界、载具/约束/接触及资源释放 |
| `src/domain/scene-assets/*`、场景渲染桥 | 整场GLB节点绑定、运行实例克隆、可视/物理变换同步 |
| `src/features/catalog/AssetPanel.tsx`、`src/contracts/catalog.ts`、`src/domain/catalog.ts`、`commands/workspaceCommands.ts`、`stores/workspace` | 场景分类、目录加载、原子导入、命名空间、工程持久化 |
| `src/features/plc/PlcPanel.tsx`、拟新增`PlcModuleGraph.tsx`与图模型转换器 | 模块布局、控制/信号边区分、只读实时状态、信号日志 |
| `src/features/runtime/*` | 场景运行工具栏、阻塞原因、绑定/标定入口与统一会话状态 |
| `public/scene/S01—S12/device`、`scene.json`、`process.py` | 真实资产与任务迁移；保留现有GLB目录及独立验收目标 |
| `tests/`、`e2e/` | 编译反例、调度状态、物理证据、多场景回归及PLC视图对照 |

实施涉及Next页面/接口时先阅读本项目AGENTS.md要求的本地Next文档。构建脚本及源码要用仓库当前依赖验证，不根据旧版Next经验假设运行方式。

## 11. 实施阶段与准入门槛

| 阶段 | 主要交付 | 进入下一阶段的证据 |
| --- | --- | --- |
| P0 资产清查 | 十二场景节点清单、S01设备角色表、schema/任务字段规范、外部服务清单 | 所有DSL符号有唯一来源；未标定项明确；旧batch/bindings信息有迁移映射 |
| P1 场景包与编译 | 0.4前端、Device实例绑定、ProcessIR/BoundProcess、依赖锁 | 十二份语法与引用可检查；错误行为、类型、节点和哈希拒绝；迁移前后目标与数量一致 |
| P2 统一运行内核 | 一个世界/时钟、阶段拆分、多设备信号与资源、停止/取消 | 每tick物理只推进一次；重复tick不重复提交；单设备回归不退化；未实现能力阻塞 |
| P3 S01/S02闭环 | 真实多机器人/托盘、定距输送、接触交接、外部接盘 | S01三盘十二件、S02六盘二十四件独立目标通过；并行重叠与互锁有时间日志和物理证据 |
| P4 其它设备和场景 | 环线、升降、旋转、仓储、加工/装夹、换盘 | 逐场景通过第7节证据；每个设备适配有正常/故障/取消反例；加工契约正式补齐后才解除准入 |
| P5 资产库与PLC整合 | 十二场景卡片、导入/重开、实时模块图、状态日志 | 端口100%可追溯，动态值逐tick与快照一致；重复导入不串线；未知和断线不显示成功 |
| P6 整体验收 | 十二场景可重复运行报告、性能/资源基线、文档与可复现命令 | 全部场景分别证明可运行；连续启动/停止/重开不泄漏；不存在mock或计时成功替代物理证据 |

P1可先做静态模块拓扑，P2后接真实值，P3起端到端验证；不要等所有设备完成后才检查PLC数据源。遇到节点不可分离、缺轴/TCP或加工能力未定义等阻塞时，保留场景可浏览状态并报告具体缺口，不能为凑齐十二个绿灯降低准入。

## 12. 验证矩阵

### 12.1 编译与迁移

- 任意Python语句、未知行为、错单位、越界身份、缺节点、模糊节点、缺停止协议、旧IR哈希、未知集合均拒绝。
- batch/bindings停用前比较物料/托盘ID集合、订单数量、配方次数、初始装载、终态目标及所有信号来源，无静默丢字段。
- 构建后删除旧batch/bindings运行入口仍能校验；修改device中的端口/版本或节点哈希会使BoundProcess失效，不能退回旧文件。

### 12.2 行为与物理

- 单设备现有输送/机器人测试继续通过；多个设备不会导致世界在一个tick推进多次。
- 条件未知不提交；旧Done不完成新请求；抓放失败不生成虚假持有/交接；par失败触发兄弟停止；取消不导致带物体掉落或重复释放。
- 单独测试表面运动而物料打滑、物料掉落、工具未接触、目标被占、错物料到位、请求重复、失能与恢复、出口不接盘。
- 比较实际body位姿/速度/contact/constraint与目标，不以UI动画或count增加作为成功判据。真实轨迹与目标不可达时明确失败。
- S01/S02有真实并行时间区间；S09机器人互斥而两机加工可重叠；S12工序顺序和交接身份无串件。

### 12.3 PLC面板与资产库

- 从BoundProcess生成端口表，逐项比较实例契约端口ID/类型/方向；空间接口和不存在的统一端口不得混入。
- 记录运行快照与面板渲染值的tick/runId，验证值、质量和请求一致；初始未知、暂停、断线、重置和快速边沿均有测试。
- 图中的控制边与信号边可区分；同设备跨步骤不复制写入者。UI不通过计时器、随机数或步骤序号写假反馈。
- 场景列表恰有十二个包；重复导入命名空间隔离；预检失败回滚；保存重开后设备映射和任务一致。

### 12.4 命令与交付报告

沿用现有`npm run typecheck`、`npm run lint`、`npm test`、`npm run build`、`npm run test:e2e`，按改动范围执行。新增建议命令`scene:check`、`scene:compile`、`scene:run-headless`需随实现提供真实退出码，不把建议命令写成当前已经可用。

场景验收报告至少包含源/模型/契约哈希、配置、随机种子（如使用）、runId、实际物理步数、请求与信号轨迹、每件物料交接和工序证据、停止结果及独立目标判定。静态通过、可导入、适配就绪、物理运行通过分别列出。

## 13. 已落地基础与剩余工作

当前落地范围为P0/P1的部分基础及P2的阶段所有权基础，不表示P0—P6全部完成。

- 新增scripts/build-scene-catalog.py及受限AST前端，十二场景迁移到ac-declarative/0.4。process声明device目录、有限production和独立目标，生成带输入哈希的IR及场景目录；正常构建不读取旧batch.json/bindings.json。旧文件保留作迁移参考。
- 每个场景新增scene.json及device实例声明，保留参数、行为/信号契约、位置声明、标定、配方、初始对象及载荷信息。GLB保持原文件，不拆分；node_binding当前全部unresolved。这些是待绑定声明，不是已完成真实资产标定。
- 资产库新增场景分类，支持十二场景的整场模型导入、命名空间隔离、BOM选择、模型哈希校验、项目保存字段及恢复。导入失败不提交工程；源文件变化要求重新编译。
- PLC面板在选中场景时显示契约接口块及对应工艺调用；所有运行值保持未知。当前没有控制边布局、可执行PLC接线或场景实时信号流，不伪造动态变化。
- 新增SceneWorldStepper，定义所有驱动beforePhysics→一次world.step→所有驱动afterPhysics，以及暂停、受控停止期限和未确认停止保护。它还未替代现有RuntimeKernel或连接完整工艺调度器；测试中的驱动桩仅验证阶段顺序，不作为物理执行证据。

验证入口：

```powershell
npm run catalog:scenes
python -B -m unittest discover -s scripts/tests -p test_scene_compiler.py
npm run typecheck
npm run lint
npm test
npm run build
```

本批已通过100项TypeScript单元测试及6项Python编译反例测试、类型检查和lint，并完成生产构建。浏览器已验证十二场景分类、S01整场GLB导入、项目保存后新标签页恢复、PLC契约端口显示及未知值；浏览器控制台未出现错误。完整端到端运行与十二场景物理实验未完成。

下一批必须完成：S01真实节点/关节/TCP/碰撞/节距标定；工艺控制树调度与统一请求/资源系统；设备求解器接入单物理世界；真实信号快照与控制/信号拓扑图。加工契约、环形输送、升降/旋转及外部换盘服务逐项实现后才解除对应运行阻塞。不能通过改executable字段或默认信号值跳过这些工作。

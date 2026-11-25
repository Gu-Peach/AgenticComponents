# 场景工艺 DSL 规范

工作台规范 2026-11-25 · 基准 `3c0feda`

作者语言 `ac-declarative/0.4` · 编译表示 `ac-coordination-ir/0.4` · 发布物 `scene-bundle/0.1`

本规范适用于场景包中的 `process.py`。它继承 `test1/dsl_new` 的声明式工步语义，按工作台当前编译、绑定和执行行为说明可用写法。工艺作者确定任务清单、顺序、并行、分支、目标端点和每次动作的参数。设备契约提供行为签名及其固有条件，调度器根据资源和实测反馈推进。设备安装连接、轴系、抓取坐标系、工件容量和型号能力分别来自场景装配与设备定义。[设备契约规范](./device-contract.md)

## 1. 文件入口和有限任务

文件只有一个 `with process(...):` 声明，里面有且仅有一棵控制树。多个顶级工步用一个 `seq` 包裹。解析器读取 Python AST，允许注释与缩进。普通赋值、导入、函数定义、任意 Python 调用、循环语句、下标和方法调用均不属于工艺语言。

| 入口项 | 作者填写 |
| --- | --- |
| 场景 ID | 第一个位置参数，字符串常量，与场景清单的 `id` 一致。 |
| `version` | 固定为 `'ac-declarative/0.4'`。 |
| `devices`、`goal` | 分别固定为 `'./device'`、`'./task-spec.json'`。构建器从 `scene.json` 的 `devices` 清单装入实例，按各实例的 `contract_ref` 解析本包契约。 |
| `task` | 使用下表三种 `production` 形式之一。关键字的值是有限字面数据，工步只能读取这些值和派生的任务字段。 |

| 任务形式 | 用途与约束 |
| --- | --- |
| `production(jobs=[...], pallets=[...])` | 两个列表都要给出，未使用的列表填 `[]`。每个订单的 `material` 标识物料。任务也可显式列出托盘及其 `items`。场景可给订单附加工艺字段，如 `input`、`slot`、`target` 或轴目标。当记录含 `prototype` 时，它须引用本包的物料原型，展开后生成该物料唯一的运行身份。 |
| `production(carrier_template='Pallet', count=3)` | 按指定托盘原型及槽位展开指定盘数。S01 和 S06 的原型已经装料，各工件有原槽 `item.source`。对于空盘原型，这种形式使用原型中的完整装载清单。 |
| `production(carrier_template='Pallet', count=6, per_carrier={'lower': 12, 'cover': 1, 'upper': 12})` | 空盘按类别指定每盘数量。类别必须出自该原型，数量为非负整数，合计至少一件，且不超过对应的槽位容量。按原型槽位顺序分配。还要满足部分装载策略和支承层关系。S02 展开为六盘、150 件，每件有 `item.target`。 |

展开后可读 `task.jobs`、`task.pallets`、`task.job_count`、`task.pallet_count`、`task.material_count`、`task.max_items_per_pallet`。托盘批次编号形如 `P01`，按其预制槽位展开的物料编号形如 `M01_01`。显式订单使用作者给定身份。物料 ID 必须唯一。两个字面列表各至多 10,000 行，任务物料总数至多 10,000。原型生产盘数为 1–10,000。实际批次数还受容量和有限展开预算约束。[S01 预装批次](../scene/S01/process.py) · [S02 分层装载任务](../scene/S02/process.py) · [S07 显式订单](../scene/S07/process.py)

## 2. 可发布的控制树

每个控制节点和叶节点的第一个位置参数均为非空、文件内唯一的字符串 ID，用于诊断、跟踪和回执关联。同一个写在循环体内的工步可激活多次，由引擎分配不同的激活与请求身份。静态工步 ID 上限为 10,000，节点深度从 0 起且小于 64。

| 写法 | 条件和推进规则 |
| --- | --- |
| `with seq('id'):` | 顺序访问子节点，前一节点完成后进入下一节点。 |
| `with par('id', join='all'):` | 至少两个直接子节点。它们可并发提出请求，争用同一资源时由调度器仲裁。全部分支完成后汇合。 |
| `with repeat('id', count=N):` | 重复一棵子树，`N` 为 0–10,000 的整数。即便 `N=0`，编译器仍检查循环体。 |
| `with repeat('id', over=集合, bind='item', limit=上限):` | 入口求取集合快照，逐项按次序绑定。上限为 0–10,000 的整数，集合超过上限会失败。绑定名使用普通标识符，避开保留名及已有实例或外层绑定。静态检查要求一个可推断元素的非空集合。空筛选结果也会被拒绝。每个循环均恰好有一个子树，多步用 `seq`。 |
| `with branch('id', mode='exclusive', timeout=seconds(30)):` | 至少一个 `with case(布尔表达式):`，最后恰好一个 `with otherwise():`，各自恰好一个子树。`exclusive` 发现多个真分支会失败。有未知值时等待。`ordered` 按书写顺序选第一个真分支，遇到可能改变选择的未知值时等待。所有条件确定为假才进入 `otherwise`。两种模式均有逻辑超时。 |
| `invoke('id', 设备, '行为', ...)` | 发出一个可调度的有限动作。签名、资源、实测完成条件见下一节。 |
| `delay('id', milliseconds(200))` | 有意引入逻辑时间延时。时钟到期只完成该延时节点。允许零时长。 |
| `fail('id', '非空错误码')` | 显式终止这条工艺的正常推进，走调度器故障处置。 |

分支超时取正时长，延时取非负时长。运行时单个时长不超过一天。逻辑时间按每秒 60 个 tick 向上取整。设备动作通过行为条件等待就绪和完成。作者不需要为每个动作重复写等待或推算延时。静态展开最多访问 200,000 次节点，运行期另有激活数量上限。[S01 并发抓放](../scene/S01/process.py) · [S05 分支语法示例](../scene/S05/process.py)

## 3. 表达式与动作载荷

| 输入 | 支持的写法与语义 |
| --- | --- |
| 值与引用 | 字符串、整数、有限小数、布尔值、负数常量、整数加减。设备用已登记的实例符号，`C1.exit` 解析为该实例的具名位置。任务或当前循环行使用 `task.jobs`、`job.material`、`item.source` 等字段。支持字符串形式的已登记端点，如 `'scene.sorting'`。 |
| 带单位量 | `quantity(值, '单位')`，如 `quantity(job.in_slot_position, 'm')`、`quantity(180, '°')`。量纲参数必须与所选行为签名的单位字符串一致。米、毫米、弧度、角度之间没有隐式换算。时长使用 `seconds(x)` 或 `milliseconds(x)`。 |
| 条件及集合 | `eq(a,b)`、`ne(a,b)` 比较同类型标量。`select(pallet.items, category='lower')` 按行字段匹配。`chunks(集合, size=N)` 按 1–10,000 的整数分组。 |
| 实例数据查询 | `subject_id(物料或托盘标识)` 按本次场景登记的身份转换到动作要求的数值主体。`calibration(设备, 键)` 从已声明标定记录取得带单位量，待标定值会阻塞依赖它的运行。`items_at(位置, category='A')` 请求库存集合，类别可省略。后二者的静态检查可通过，实际运行须有对应的运行时读取函数和数据提供者。 |
| 结构载荷 | `payload('实例.命令绑定', 字段=值, ...)` 仅用在 `invoke` 的 `payload=` 位。载荷中的物料、端点、工具等引用有各自的类型与归属。 |

`invoke` 的目标设备须能静态解析为本包的实例。普通关键字按行为的 `arguments_schema` 检查必填项、未知字段、类型、单位和已声明范围。运行绑定还会检查型号的 `applicability` 和 `argument_variants`。例如 S07 的 `move_to_position.position_m` 表示沿轨道局部正轴、相对零位的有符号绝对位置，`lift_to_level.move_to_level` 表示平台相对设备基座的绝对高度。S11 的 `rotate_to_station.angleTag` 是绝对工位角，必须在设备声明的允许工位内。[S07 数值定位](../scene/S07/process.py) · [S11 转台工位配置](../scene/S11/device/T1.json)

`payload` 的首参查实例 `command_payloads`，其来源包括契约的 `runtime_execution_contract.payload_templates`。作者应提供 `fields` 中的所有必填键，额外键仅限 `optional_fields` 声明的键。普通抓放可按该物料已声明的抓取坐标系填写可选 `grasp`。S04 交接分别传 `giver_grasp`、`receiver_grasp`，属于同一件物料的不同抓取帧。工具及加工口按所属设备和物料查找并校验兼容。兼容绑定须由运行配置明确登记，例如 `robot-handoff@1` 的通用抓放入口可选择已有的取件交接或持件放置命令签名。未知绑定、跨设备重定向或不存在的帧会被拒绝。[S04 双臂交接](../scene/S04/process.py) · [S06 逐件加工并返回原槽](../scene/S06/process.py)

## 4. 完整场景示例

以下为当前 S11 的完整工艺。四行订单使用同一物料原型，运行身份与加工回执分别记录。人物按 `handle` 搬入，转台转至加工工位，机械臂按 `torch` 与 `weld` 对接。加工并退回后，转台转回人工工位，由人物带走该件。[场景清单](../scene/S11/scene.json) · [工艺源文件](../scene/S11/process.py) · [独立验收目标](../scene/S11/task-spec.json)

```python
with process('S11', version='ac-declarative/0.4', devices='./device', task=production(jobs=[
    {'id': 'J01', 'material': 'M01', 'prototype': 'Workpiece', 'input': 'F1.work', 'target': 'F1.work'},
    {'id': 'J02', 'material': 'M02', 'prototype': 'Workpiece', 'input': 'F1.work', 'target': 'F1.work'},
    {'id': 'J03', 'material': 'M03', 'prototype': 'Workpiece', 'input': 'F1.work', 'target': 'F1.work'},
    {'id': 'J04', 'material': 'M04', 'prototype': 'Workpiece', 'input': 'F1.work', 'target': 'F1.work'},
], pallets=[]), goal='./task-spec.json'):
    with repeat('workpieces', over=task.jobs, bind='job', limit=task.material_count):
        with seq('weld_one'):
            invoke('load_fixture', H1, 'carry_material',
                   payload=payload('H1.carry_material', material=job.material, source=job.input,
                                   target=T1.slot1, grasp='handle'))
            invoke('index_to_robot', T1, 'rotate_to_station', angleTag=quantity(180, '°'))
            invoke('weld_and_retreat', R1, 'process_material',
                   payload=payload('R1.process_material', material=job.material, station=T1.slot1,
                                   tool='torch', process='weld'))
            invoke('index_to_operator', T1, 'rotate_to_station', angleTag=quantity(0, '°'))
            invoke('unload_fixture', H1, 'carry_material',
                   payload=payload('H1.carry_material', material=job.material, source=T1.slot1,
                                   target=job.target, grasp='handle'))
```

S11 的配套 `task-spec.json` 在 `expected.material_ids` 中给出 M01–M04，在 `expected.pallet_ids` 中给出空列表。`all_delivered_once` 为每件声明最终交接点 `F1.work`，`required_operations` 将焊接回执绑定到 R1 的 `torch`、物料的 `weld` 和 `T1.slot1`。只改变可达工位的角度时，应同时更新转台的工位配置和 DSL 设定值。改变件数、交付点或必需工艺时，还应更新独立验收目标。工步顺序由 `process.py` 决定。

## 5. 从编译到验收

1. **编译与发布。** 场景清单登记模型、源文件、实例和目标。构建器校验哈希与节点归属，解析工艺、展开有限任务，核对目标文件中有序的物料和托盘身份及数量，再逐调用校验设备和载荷。得到的场景包记录 `process.body`、任务、静态调用清单、设备及 `blockers`。静态调用数按源节点计，同一调用的循环执行次数取决于任务。
2. **运行准备。** 工作台复核导入包、模型、源文件哈希，并按所选运行模式和设备组合装配实际轴、碰撞体、支承、条件提供者和资源。当前生成包统一声明 `executable=false`。已接入的组合可在明确选择候选仿真且通过准备检查后使用实测反馈运行。节点未绑定、所需标定缺失、可调度行为缺少执行器等状态须保留诊断。S05、S08、S09、S12 的实验设备调用会标记 `EXPERIMENTAL_CONTRACT_NOT_ADMITTED`。
3. **执行与交付。** 调度器为每次调用冻结参数和载荷，关联 `runId`、`activationId`、`requestId` 和适用的物料身份，校验前置条件与资源并提交给设备。设备确认接受后保持必要的持续互锁，用实测位置、停稳、接触、抓持、库存或相应回执确认完成。后继动作仍须满足自身前置条件。S04 还按物料和端点消费连线上对应的执行证据。超时、取消、执行失败进入停止与资源处置。正常收尾还要与独立 `task-spec.json` 的要求核对。
4. **结果解释。** S01、S02、S04、S06、S07、S11 已有物理回放路径。S07 的正式四件任务要求保留第四层，带载净空不足时会报告 `TARGET_UNREACHABLE`。S03、S05、S08、S09、S10、S12 虽可发布工艺声明，当前包内仍有待完成的节点绑定。编译通过、候选仿真准入、独立任务验收是三个分别记录的结果。[S07 场景说明](../scene/S07/README.md) · [S06 验收目标](../scene/S06/task-spec.json)

在仓库的 `apps/` 目录下可构建全部场景。下面的命令检查 S11，并将校验产物写入临时目录。

```powershell
python -B scripts/build-scene-catalog.py --scene S11 --output-root "$env:TEMP/ac-scene-check"
```

## 6. 参考语言与工作台 IR 的边界

- `test1/dsl_new/declarative_dsl/领域语言规范.md` 的参考入口为 `0.3`，绑定、批次与工艺分文件保存。`0.4` 将场景设备目录、有限生产任务和目标文件接入 `process` 头。迁移时，将旧 `batch.json` 的生产数据转为 `production(...)`，将工步中的 `batch.*` 按实际任务字段换为 `task.*`。将旧 `bindings.json` 中的设备、点位和命令绑定分别落实到场景实例、型号契约及命令载荷，再核对 `task-spec.json` 的身份与数量。
- `with_control` 可被语法解析且 TypeScript 调度器有持续控制分支，当前整场景 Python 静态校验未实现该节点。`wait_for` 在本入口语法阶段已禁止。`lt/le/gt/ge`、`all_of/any_of/not_`、`fact`、`carrier_plan` 以及单独作为工步表达式的列表、字典，在需要由当前 Python 校验器求值的位置也不能作为可发布语法使用。任务头中的列表和字典由有限字面数据规则处理。
- “挂载定位”和“组合工艺·输送后抓放”面板可读 JSON 格式的工艺 IR，入口取 JSON 的 `body` 或直接取根节点。挂载定位按所装配的 `rail`、`lift` 角色或实际实例 ID 绑定，接收以 `m` 为单位的数值定位字面量。每个编辑器按自身设备组合验证可用行为。完整的 `process.py` 仍通过场景构建器发布。

实现对照可查仓库中的 `apps/scripts/build-scene-catalog.py`（文件头、发布）、`apps/scripts/lib/declarative_frontend.py`（语法）、`apps/scripts/lib/scene_binding_check.py`（静态求值与调用）、`apps/src/domain/runtime/bindDeviceBehavior.ts`（型号绑定）和 `apps/src/runtime/scheduler/ProcessScheduler.ts`（执行语义）。

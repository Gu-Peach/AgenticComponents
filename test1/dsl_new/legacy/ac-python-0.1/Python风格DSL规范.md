# Python 风格工艺 DSL：ac-python/0.1

设计方向已更新为[契约驱动的声明式协作DSL](declarative_dsl/领域语言规范.md)。下文描述仍在使用的ac-python/0.1原型及其检查入口；它尚未实现新规范的九节点声明式控制。

本语言用于明确描述设备动作及动作之间的组织关系，并形成可以提交给场景驱动的控制模型。设备契约定义一项行为如何调用和确认；工艺 DSL 决定由哪台设备、对哪个对象、何时调用、如何等待和协作。

脚本采用合法 Python 的受限语法，由专用前端读取 AST 并生成 `ac-control-ir/0.1`。它是领域语言源文件，不通过 Python 的 import、exec 或 eval 执行。`async`、`await` 和 `async with` 在这里表达工艺语义，不意味着采用 asyncio，也不隐含已经接入 SimPy。

## 文件与职责

| 层 | 权威内容 | 职责 |
| --- | --- | --- |
| 设备契约 | asset_contracts/assets/*.json | 通用行为、参数、信号、执行条件、完成证据、停止规则 |
| 场景绑定 | processes/Sxx/bindings.json | 设备实例、能力、参数、位置、配方、资源和外部事件 |
| 批次清单 | processes/Sxx/batch.json | 本批全部任务、物料、托盘及其装载/目标关系 |
| 工艺程序 | processes/Sxx/process.py | 顺序、循环、并发、等待、互斥、工位协调 |
| 独立目标 | processes/Sxx/task-spec.json | 整批验收，避免候选程序自己宣布成功 |
| 控制 IR | 编译结果中的 ir | 与源语言无关的控制节点和具名参数 |
| 场景驱动 | 后续运行器与设备适配器 | 推进任务、调用协议、驱动场景并读取实际证据 |

当前 `process.py` 是工艺源文件。旧 Lisp 文件归档在 `legacy/ac-flow-0.2/`，用于迁移回归，生产检查入口不从旧文件读取当前程序。编译结果可重新生成，不维护第二份可独立编辑的工艺。

## 入口与命名空间

```python
@process(version="ac-python/0.1", scene="S04")
async def main():
    await parallel_for(batch.jobs, handle_job, max_active=2)
    await verify("batch_goal")
```

模块只能包含顶层 `async def`，且恰有一个被 `@process` 声明的无参数入口。其他函数为可复用的工艺片段/worker，没有装饰器和默认参数；必须被入口直接或间接使用，不允许递归。

前端提供以下符号：

- `batch`：只读有限批次。`batch.jobs`、`batch.pallets`、`batch.cells` 必须对应本场景清单。
- `R1`、`C1` 等：bindings 中的稳定实例 ID，解析后关联该实例的契约。
- `C1.entry`、`R1.home` 等：已登记的位置引用，必须能在 locations 中解析；不是访问任意 Python 对象属性。
- `job.material`、`cell.robot` 等：当前词法作用域中的记录字段。字段最终绑定物料、实例、位置、配方或数值。
- `wait`、`resources`、`parallel_for`、`dispatch_waves`、`verify`、`checkpoint`、`quantity`、`ticks`、`items_of`：本规范定义的固定构造。

同名字段不消除名义类型。`job.material` 不能传给位置参数，位置不能冒充配方。禁止私有/特殊属性、函数名和循环变量遮蔽保留符号，循环变量也不能遮蔽外层任务变量。

## 单行为调用及信号映射

```python
await R1.transfer_material(
    material=job.material,
    source=C2.exit,
    target=C1.entry,
)
await R1.move_to_location(target=R1.home)
```

第一句调用 R1 的契约行为，第二句只在第一句确认完成后执行。动作只能使用具名参数，名称、类型、单位和能力开关须与契约相符。每个调用编译为一个独立 IR 节点，前端生成诊断 ID 与源文件行列映射，不要求作者手工填写 op_001。

一个 invoke 的执行要求如下：

1. 读取绑定实例和行为定义，解析本次物料、位置与其他参数。
2. 在动作准备启动时读取一致快照，检查 preconditions 和当前资源/容量授权；未满足可等待，无效或缺失数据为 unknown。
3. 根据该行为的 command_bindings 写入逻辑输入。例如 transfer_material 的 material/source/target 映射到对应端口；command_code 来自契约。
4. 场景驱动提供运行/实例/请求身份，按 request_v1 提交并等待匹配接受回执。输入参数在接受时冻结，不能在执行中偷换目标。
5. 执行中检查 sustaining_conditions。只有匹配本次请求的结果和全部 completion checks 成立，await 才完成。
6. 失败、取消或超时按停止规则处理；停止未确认时保留必要隔离。不能用旧 Done、单纯空闲或动画时长届满代替完成。

作者不在每个工艺脚本里重复编写这些协议。契约负责规则与映射，适配器负责落实实际命令和观测；DSL 不会仅因行为名存在而自动拥有执行器。

被动资产的观察/响应不能直接调用为生产动作。托盘和仓储柜作为位置、载具及容量对象参与流程，实际运动由已登记的主动设备承担。

## 顺序与有限循环

同一函数中相邻语句按顺序执行；显式 await 动作/检查后才进入下一句。

```python
for job in batch.jobs:
    await wait.input_present(job.material, job.input, timeout=ticks(1800))
    async with resources(C2):
        await C2.transport_to_exit(
            material=job.material,
            speed_mps=quantity(0.2, "m/s"),
        )
```

`for` 只遍历已登记的有限清单或当前记录的有限清单字段。不得使用 range、动态生成器、while、循环else或无界循环。本版没有索引、自增、列表推导或任意赋值；每件物料和每个托盘的身份由清单显式提供。

循环作用域是工艺词法作用域，变量不泄漏到后续语句。运行身份须由 run、scene、任务 ID、循环路径和 IR 节点组合形成，再映射为设备请求身份。重复调用同一模板不得复用上次请求结果。

## 有界并发与工艺片段

```python
async def handle_job(job):
    # 当前任务的设备动作与等待。
    await wait.input_present(job.material, job.input, timeout=ticks(1800))
    async with resources(C2):
        await C2.transport_to_exit(material=job.material, speed_mps=quantity(0.2, "m/s"))

# 放在 main 或其他被使用的工艺函数内：
# await parallel_for(batch.jobs, handle_job, max_active=2)
```

`parallel_for(collection, worker, max_active=N)` 同时最多开放 N 个任务实例，N 为1至8的整数字面量。一个任务结束后才接纳后续任务，清单全部结束后汇合。worker 有且仅有一个任务参数。

这里的并发是工艺任务交错，可由一个离散事件时钟调度；不要求多线程。单个worker内部仍按顺序执行。实例占用、物料占用、容量和互锁仍限制哪些动作能真正同时推进。

`await helper(job)` 可顺序调用顶层辅助工艺函数，前端按实参绑定展开到 IR；禁止递归、闭包、lambda和返回任意对象。当前版本没有条件分支语法；现有场景的条件组织通过 await、有限任务记录与明确的工位选择规则表达。新增分支时须同时定义语义、IR和检查，不由任意Python控制流代替。

## 条件等待与时间

```python
await wait.target_available(C1.entry, timeout=ticks(1800))
await wait.output_departed(job.material, C2, timeout=ticks(1800))
```

每个等待必须有显式正整数 tick 期限；当前绑定时钟为60 Hz，1800 tick等于30秒仿真时间。时间与计算机墙钟耗时不同。条件提前成立就继续；超时不代表成功，也不证明目标在所有路径下不可达。

等待方法以 [统一登记表](language/wait-predicates.json) 为准，当前完整清单如下：

| 方法 | 参数 | 等待什么 |
| --- | --- | --- |
| `wait.input_present` | material, location | 指定物料实际到达入口或取料位置，身份和支承有效 |
| `wait.target_available` | location | 目标位置当前可接收；动作提交时仍需原子预留 |
| `wait.output_available` | device | 出料设备当前具有接收容量和可用状态 |
| `wait.output_departed` | material, device | 指定物料已在对应出口完成交接并被下游移走 |
| `wait.empty_pallet_present` | pallet | 指定空托盘已换入码垛工作位并停稳 |
| `wait.full_pallet_departed` | pallet | 指定托盘已按清单装满且由外部换盘方移走 |
| `wait.carrier_present` | pallet, location | 指定载料托盘实际到达主线入口或指定位置；不要求托盘为空 |
| `wait.carrier_empty` | pallet | 指定托盘没有剩余实际物料或未提交交接 |
| `wait.carrier_departed` | pallet | 指定空托盘已到达主线末端并被外部接盘方移走 |

前端与绑定检查器共同读取此登记表。证据提供者与只读要求见[等待条件目录](等待条件目录.md)。

wait只读取当前有效证据。来料、物料离开、换盘必须由 bindings 中登记的外部提供者实际执行并确认，不能靠调用await创建物料、清除占用或自动满足条件。

数值动作参数使用 `quantity(value, unit)`，value可为数值常量或当前记录的数值字段。单位必须与契约相符，例如 m、m/s、rad。期限使用 `ticks(N)`。当前版本不隐式换算单位。

## 资源与工艺协作

```python
async with resources(R1, C1, C2):
    await R1.transfer_material(material=job.material, source=C2.exit, target=C1.entry)
    await R1.move_to_location(target=R1.home)
```

资源组原子申请，不能部分获得后等待其余成员。资源作用域在退出前保留操作权限，保障交接和退位期间不会被冲突动作干扰。同任务的嵌套资源允许重入；竞争任务公平排队。

这个构造由DSL运行器解释，不是直接执行Python上下文管理器。正常退出释放临时操作许可，但不会清空物料实际占用；异常退出必须先完成相应取消/停止协议，停止未知则保留必要隔离。不能套用“异常后无条件释放所有锁”的实现。

目标可用的await和动作提交之间必须复核并原子预留容量。容量属于物料/载具事实，不能仅用设备操作锁代替。运行器应记录等待原因和等待资源；本版静态检查不证明任意并发调度无死锁。

## S02：托盘与空闲工位协调

```python
async def unload_pallet(pallet, cell):
    for item in pallet.items:
        await wait.output_available(cell.output, timeout=ticks(1800))
        async with resources(cell.robot, cell.output):
            await cell.robot.transfer_material(
                material=item.material,
                source=item.source,
                target=cell.output_entry,
            )
            await cell.robot.move_to_location(target=cell.home)
            await cell.output.transport_to_exit(material=item.material, speed_mps=quantity(0.2, "m/s"))
        await wait.output_departed(item.material, cell.output, timeout=ticks(1800))

@process(version="ac-python/0.1", scene="S02")
async def main():
    await dispatch_waves(
        batch.pallets, batch.cells,
        worker=unload_pallet, line=C1, transport="index_carriers",
        policy="fifo-first-reachable-idle",
    )
    await verify("batch_goal")
```

worker参数固定为 pallet、cell，前端将它们解析成已登记托盘和候选工位记录。协调器按FIFO选择可到达、空闲、输出可接收且共同运动计划可行的工位；无可用工位则等待。

每波依次完成：冻结分配与运动计划 → 全部机械臂退位 → index_carriers入站并确认主线停稳 → 并行执行各工位worker → 核对整盘清空且所有worker退位 → index_carriers空盘出站 → 确认空盘移走并释放容量。波内机械臂可并行，整条主线在拆垛时保持停止。

当前S02仍为6盘、每盘4件、3个工位；名义情况下两波完成，但工位暂不可用时可采用较小波次。SimPy或其他后端必须落实同一规则，不能把遍历所有候选工位的静态检查误当实际工位分配。

## 完成、异常与独立验收

入口最后必须 `await verify("batch_goal")`，并等待所有循环/并发/波次节点结束。独立task-spec按物料/托盘完整ID清单、目标交接、工序历史、设备清理判定，不能只读程序内部完成计数器。

`await checkpoint("inventory_stored")` 是S07使用的批次阶段检查：全部指定物料已入指定库位，才进入出库循环。

默认异常规则来自bindings.execution：停止接纳新任务，取消相关活动分支，等待确认停止或attention_required。失败任务不得静默删除后把剩余任务算作整批完成。本版不开放try/except供脚本吞掉设备故障。

## 语法白名单与静态检查

允许：顶层async函数、入口声明、有限for、async with resources、await固定操作、只读记录字段、具名动作参数、quantity、ticks和items_of有限筛选。禁止：导入、赋值、普通def、类、任意装饰器、while、if、推导式、索引、lambda、任意运算、try、return、yield、星号展开、递归及任意系统调用。

静态前端检查语法白名单与作用域，生成带动作源映射的控制IR；绑定检查再校验行为、参数、名义类型、单位、能力、资源、批次身份和代表性动作意图。未知语法须报错，不能通过exec兼容执行。

```powershell
# 检查当前十二份Python DSL及其场景绑定。
python -B tools/check_flows.py

# 查看某份工艺的控制IR和动作源映射。
python -B tools/compile_python.py processes/S01/process.py

# 可选：输出派生产物。
python -B tools/compile_python.py processes/S01/process.py --output artifacts/S01.compiled.json

python -B -m unittest discover -s tests -p "test_*.py"
```

仅编译脚本不代表绑定或工艺验收通过，完整检查使用check_flows。不要直接运行 `python processes/S01/process.py`；其中的设备、wait和工艺声明是DSL符号，没有自动提供的Python运行时对象。

## 与场景驱动及SimPy的接口

后续驱动接收已绑定控制IR和冻结数据，不直接执行DSL源代码。它维护程序节点、任务和请求身份，评估条件，协调资源，调用设备契约适配器，并将反馈投影为本次动作事件。

SimPy可以作为该驱动的时间与事件后端：worker实例对应Process，动作/条件对应Event，并发节点等待所有子事件。原子资源组、容量事务、故障停止与请求关联仍由契约运行层实现，不能假定SimPy自带这些工业语义。

当前实现完成了Python前端、控制IR、十二场景迁移与静态验证。实际SimPy后端、设备命令执行、物理反馈和并发调度验收尚未完成；检查结果保留runtime_ready=false。

迁移测试比较旧Lisp与新Python产生的规范化控制IR，忽略诊断ID和无意义的单层sequence包装。它说明当前控制结构、参数和等待规则保持，不是实际运行等价证明。旧源文件与迁移记录仅作回归依据；以后有意修改工艺时，应显式审核对应预期，而不是重新编辑旧源来驱动场景。

## S01托盘分类路线

S01按用户确认的物流方向使用有限托盘循环：carrier_present确认入线，transport_carrier_to由DSL明确指定R1/R2停靠点，辅助函数通过items_of筛取对应类别，carrier_empty确认清空，调用输送至出口，carrier_departed确认离开。三项新增等待的提供者、主体及完成判据见[场景说明](processes/S01/README.md)。它们分别依赖外部供盘与世界观测、库存/交接服务、外部接盘与出口观测；都需要有效主体、运行代次和采样时间，不产生移动或库存修改。

S01已主动修正此前错误的“短线→主线→固定托盘”路线，不再要求它与历史Lisp程序语义一致。其余十一场景仍保留迁移等价回归。


## 数据与控制的边界修正

batch是本次生产任务/订单数据：有哪些托盘和物料、各自的类别、装载关系以及业务要求。它不定义逐步工位、行为名和工序顺序。设备契约定义通用可调用能力，bindings提供实例和现场事实，process.py才负责组合行为。

S01不再读取pallet.stops、stop.transport_plan或绑定文件中的逐步transport_plans。其DSL直接写明到R1工位、处理A类、到R2工位、处理B类、清空并出线。conveyor.transport_carrier_to(carrier, target)是新增的通用契约行为；当前位姿到目标的底层运动计划由执行层派生。

支持固定的有限筛选构造：

```python
for item in items_of(pallet.items, category="A"):
    # 这里组合已登记设备的行为。
    await wait.output_available(C2, timeout=ticks(1800))
```

items_of只接受有限物料清单及category条件。类别是字面量或由工艺辅助函数调用绑定的确定类别。它编译为控制IR中的select集合表达式，可选择零个物料；不会创建新任务、读取任意函数或执行Python推导式。若遗漏了需要处理的类别，独立整批目标仍会使流程检查失败。

只读筛选是DSL内建构造，不是任意Python逻辑。导入、任意赋值、推导式和动态eval依旧拒绝。语言负责控制组织，设备协议与信号语义来自契约。

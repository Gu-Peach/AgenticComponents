# S01：DSL 显式组织托盘分类拆垛

场景对应 `scene/assembly_order_index`。载料托盘沿C1主滚筒线进入；R1取A类物料送入绿色出料线C2，R2取B类送入绿色出料线C3；空托盘到C1末端后移走。

## 各文件的职责

| 文件 | 定义什么 |
| --- | --- |
| batch.json | 本批3盘、每盘4件、物料类别及装载槽位；不含stops、行为名、机械臂分配和逐步运输计划 |
| bindings.json | 实例契约、参数、可停靠位置及空间先后关系、工位可达机械臂、入口/出口提供者等现场事实 |
| process.py | 明确到哪个工位、何时调用哪个行为、由哪台机械臂处理哪类物料以及先后顺序 |
| task-spec.json | 按身份独立核对A类出C2、B类出C3、处理工位、全部空盘出线及清理结果 |

本轮3盘各4件、A/B各2件，是可调整的实验批量。类别是业务属性，不根据图中物料颜色自动推断。

## 主流程

```python
for pallet in batch.pallets:
    await wait.carrier_present(pallet.id, C1.entry, timeout=ticks(1800))
    async with resources(C1):
        await C1.transport_carrier_to(carrier=pallet.id, target=C1.station1)
        await unload_items(pallet, "A", R1, C2, C2.entry, R1.home)

        await C1.transport_carrier_to(carrier=pallet.id, target=C1.station2)
        await unload_items(pallet, "B", R2, C3, C3.entry, R2.home)

        await wait.carrier_empty(pallet.id, timeout=ticks(1800))
        await C1.transport_carrier_to(carrier=pallet.id, target=C1.exit)
    await wait.carrier_departed(pallet.id, timeout=ticks(1800))
```

这里三个目的地和A/B到设备的分工都写在DSL中。`unload_items` 是工艺片段，它用固定DSL构造 `items_of(pallet.items, category=category)` 从完整库存筛出所需类别，然后组合机械臂搬运、退位、出料输送和下游交接等待。筛选只读业务属性，不读取一份预先编排的动作清单。

## 设备契约如何支撑调用

conveyor 0.3.0提供通用 `transport_carrier_to(carrier, target)`：检查当前托盘、允许方向、目标属于本机、共同驱动可行、载荷和运动区清空；提交命令后，按本次请求到位、支承和实际停稳证据结束。

需要的底层运动计划由执行层根据当前场景状态与本次target派生，不由batch逐步规定。S02仍可使用既有整线多托盘index_carriers接口，语义与本次单盘定位接口分别声明。

bindings中的carrier_network不是工序：它声明现场有哪些物理停靠点、哪些机械臂能够到达，以及单向主线的空间顺序。声明某工位存在不要求工艺必须在每次生产中访问它；是否调用、何时调用由DSL决定。

本基线采用整线共驱、一次一盘；取料时主线实际停稳，机械臂退位并确认运动区清空后才继续输送。准确GLB节点、位置和机械可达性仍待标定。

## 检查范围

静态检查拒绝在batch中重新加入stops等工序信息，检查类别筛选后的完整处理、设备调用类型、托盘到达可取工位、退位后移动、禁止反向输送、清空后出线和独立目标匹配。

这些仍是契约动作成功假设下的意图检查。实际运动计划生成、场景物理推进与信号证据适配尚未实现，不能把静态位置推演当成真实完成反馈。

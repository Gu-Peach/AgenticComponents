# 工艺顺序、工位选择和类别分流在DSL中明确声明。
# batch只提供本批托盘、物料类别及装载槽位。

# | 写法 | 在我们 DSL 中的含义 |
# |---|---|
# | `async def handle_job(job)` | **定义一段可复用的任务流程**，此时还没有创建或启动任务 |
# | `await ...` | 执行一个操作，并等待它完成；操作可以是设备动作、条件等待或整批任务 |
# | `async with resources(...)` | **申请并持有一组设备的操作权限**，在这个范围内执行受保护的动作 |

# | 方法 | 参数 | 等待什么 |
# | --- | --- | --- |
# | `wait.input_present` | material, location | 指定物料实际到达入口或取料位置，身份和支承有效 |
# | `wait.target_available` | location | 目标位置当前可接收；动作提交时仍需原子预留 |
# | `wait.output_available` | device | 出料设备当前具有接收容量和可用状态 |
# | `wait.output_departed` | material, device | 指定物料已在对应出口完成交接并被下游移走 |
# | `wait.empty_pallet_present` | pallet | 指定空托盘已换入码垛工作位并停稳 |
# | `wait.full_pallet_departed` | pallet | 指定托盘已按清单装满且由外部换盘方移走 |
# | `wait.carrier_present` | pallet, location | 指定载料托盘实际到达主线入口或指定位置；不要求托盘为空 |
# | `wait.carrier_empty` | pallet | 指定托盘没有剩余实际物料或未提交交接 |
# | `wait.carrier_departed` | pallet | 指定空托盘已到达主线末端并被外部接盘方移走 |


async def unload_items(pallet, category, robot, output, output_entry, home):
    for item in items_of(pallet.items, category=category):
        await wait.output_available(output, timeout=ticks(1800))
        async with resources(robot, output, pallet.id):
            await robot.transfer_material(
                material=item.material,
                source=item.source,
                target=output_entry,
            )
            await robot.move_to_location(target=home)
            await output.transport_to_exit(
                material=item.material,
                speed_mps=quantity(0.2, "m/s"),
            )
        await wait.output_departed(item.material, output, timeout=ticks(1800))


@process(version="ac-python/0.1", scene="S01")
async def main():
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
    await verify("batch_goal")

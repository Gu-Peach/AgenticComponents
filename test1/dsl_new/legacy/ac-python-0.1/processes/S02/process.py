# 六托盘按空闲工位分配、并行拆垛与空盘出线
# 整线共同启停；一波最多3盘到位后停带，三工位并行逐件拆垛，全体退位后空盘出线。
# 受限工艺DSL：用 tools/check_flows.py 检查，不直接执行此文件。

async def unload_pallet(pallet, cell):
    for item in pallet.items:
        await wait.output_available(cell.output, timeout=ticks(1800))
        async with resources(cell.robot, cell.output):
            await cell.robot.transfer_material(material=item.material, source=item.source, target=cell.output_entry)
            await cell.robot.move_to_location(target=cell.home)
            await cell.output.transport_to_exit(material=item.material, speed_mps=quantity(0.2, 'm/s'))
        await wait.output_departed(item.material, cell.output, timeout=ticks(1800))


@process(version="ac-python/0.1", scene="S02")
async def main():
    await dispatch_waves(
        batch.pallets, batch.cells,
        worker=unload_pallet, line=C1, transport='index_carriers',
        policy='fifo-first-reachable-idle',
    )
    await verify('batch_goal')

# 三托盘各四件的批次码垛与换盘
# 单机器人逐件码放，按托盘清单完成后等待实际换盘；总计12件。
# 受限工艺DSL：用 tools/check_flows.py 检查，不直接执行此文件。

@process(version="ac-python/0.1", scene="S10")
async def main():
    for pallet in batch.pallets:
        await wait.empty_pallet_present(pallet.id, timeout=ticks(1800))
        for item in pallet.items:
            await wait.input_present(item.material, item.input, timeout=ticks(1800))
            async with resources(C1):
                await C1.transport_to_exit(material=item.material, speed_mps=quantity(0.2, 'm/s'))
            await wait.target_available(item.target, timeout=ticks(1800))
            async with resources(R1, C1, pallet.id):
                await R1.transfer_material(material=item.material, source=C1.exit, target=item.target)
                await R1.move_to_location(target=R1.home)
        await wait.full_pallet_departed(pallet.id, timeout=ticks(1800))
    await verify('batch_goal')

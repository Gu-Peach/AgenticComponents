# 四件分层入库后按订单出库
# 先完成有限入库批次，再按订单出库；共享抓放机构X1互斥。
# 受限工艺DSL：用 tools/check_flows.py 检查，不直接执行此文件。

@process(version="ac-python/0.1", scene="S07")
async def main():
    for job in batch.jobs:
        await wait.input_present(job.material, job.input, timeout=ticks(1800))
        async with resources(C1):
            await C1.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
        async with resources(X1, L1, C1, STORE):
            await L1.move_to_height(height=quantity(0.0, 'm'))
            await X1.transfer_material(material=job.material, source=C1.exit, target=L1.work)
            await X1.move_to_location(target=X1.home)
            await L1.move_to_height(height=quantity(job.height, 'm'))
            await wait.target_available(job.slot, timeout=ticks(1800))
            await X1.transfer_material(material=job.material, source=L1.work, target=job.slot)
            await X1.move_to_location(target=X1.home)
            await L1.move_to_height(height=quantity(0.0, 'm'))
    await checkpoint('inventory_stored')
    for job in batch.jobs:
        async with resources(X1, L2, STORE, C2):
            await L2.move_to_height(height=quantity(job.height, 'm'))
            await X1.transfer_material(material=job.material, source=job.slot, target=L2.work)
            await X1.move_to_location(target=X1.home)
            await L2.move_to_height(height=quantity(0.0, 'm'))
            await wait.target_available(C2.entry, timeout=ticks(1800))
            await X1.transfer_material(material=job.material, source=L2.work, target=C2.entry)
            await X1.move_to_location(target=X1.home)
        async with resources(C2):
            await C2.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
        await wait.output_departed(job.material, C2, timeout=ticks(1800))
    await verify('batch_goal')

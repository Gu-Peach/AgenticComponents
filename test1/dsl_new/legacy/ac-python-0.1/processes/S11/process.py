# 四件装夹焊接与转位下料
# 共用装卸台和转位台，逐件完成后再接下一件，保留有限批次循环。
# 受限工艺DSL：用 tools/check_flows.py 检查，不直接执行此文件。

@process(version="ac-python/0.1", scene="S11")
async def main():
    for job in batch.jobs:
        await wait.input_present(job.material, job.input, timeout=ticks(1800))
        async with resources(R1, F1, W1):
            await R1.transfer_material(material=job.material, source=job.input, target=W1.work)
            await R1.move_to_location(target=R1.home)
        async with resources(W1):
            await W1.clamp(material=job.material)
            await W1.process_material(material=job.material, recipe='welding')
            await W1.unclamp(material=job.material)
        async with resources(R1, W1, T1, F1):
            await R1.transfer_material(material=job.material, source=W1.work, target=T1.slot1)
            await R1.move_to_location(target=R1.home)
            await T1.index_to_angle(angle=quantity(3.141592653589793, 'rad'))
            await R1.transfer_material(material=job.material, source=T1.slot1, target=F1.work)
            await R1.move_to_location(target=R1.home)
            await T1.index_to_angle(angle=quantity(0.0, 'rad'))
        await wait.output_departed(job.material, F1, timeout=ticks(1800))
    await verify('batch_goal')

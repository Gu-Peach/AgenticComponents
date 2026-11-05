# 四件分度台批次与前后段流水
# 进出料可与转位工位处理重叠，T1单工位周期串行。
# 受限工艺DSL：用 tools/check_flows.py 检查，不直接执行此文件。

async def handle_job_1(job):
    await wait.input_present(job.material, job.input, timeout=ticks(1800))
    async with resources(C1):
        await C1.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.target_available(T1.slot1, timeout=ticks(1800))
    await wait.target_available(C3.entry, timeout=ticks(1800))
    async with resources(T1, R1, R2, C1, C3):
        await R1.transfer_material(material=job.material, source=C1.exit, target=T1.slot1)
        await R1.move_to_location(target=R1.home)
        await T1.index_to_angle(angle=quantity(3.141592653589793, 'rad'))
        await R2.transfer_material(material=job.material, source=T1.slot1, target=C3.entry)
        await R2.move_to_location(target=R2.home)
        await T1.index_to_angle(angle=quantity(0.0, 'rad'))
    async with resources(C3):
        await C3.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.output_departed(job.material, C3, timeout=ticks(1800))


@process(version="ac-python/0.1", scene="S06")
async def main():
    await parallel_for(batch.jobs, handle_job_1, max_active=2)
    await verify('batch_goal')

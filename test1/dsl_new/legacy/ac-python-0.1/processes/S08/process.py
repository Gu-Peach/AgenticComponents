# 四件L形加工工位流水
# 单机加工串行，下一件输送准备与当前加工/出料可重叠。
# 受限工艺DSL：用 tools/check_flows.py 检查，不直接执行此文件。

async def handle_job_1(job):
    await wait.input_present(job.material, job.input, timeout=ticks(1800))
    async with resources(C1):
        await C1.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.target_available(MC1.work, timeout=ticks(1800))
    async with resources(MC1):
        async with resources(R1, C1):
            await R1.transfer_material(material=job.material, source=C1.exit, target=MC1.work)
            await R1.move_to_location(target=R1.home)
        await MC1.clamp(material=job.material)
        await MC1.process_material(material=job.material, recipe='machining')
        await MC1.unclamp(material=job.material)
        await wait.target_available(C2.entry, timeout=ticks(1800))
        async with resources(R1, C2):
            await R1.transfer_material(material=job.material, source=MC1.work, target=C2.entry)
            await R1.move_to_location(target=R1.home)
    async with resources(C2):
        await C2.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.output_departed(job.material, C2, timeout=ticks(1800))


@process(version="ac-python/0.1", scene="S08")
async def main():
    await parallel_for(batch.jobs, handle_job_1, max_active=2)
    await verify('batch_goal')

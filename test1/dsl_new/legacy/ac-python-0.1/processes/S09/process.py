# 六件双机加工与单机器人互斥服务
# 任务按明确轮换分配到MC1/MC2，两机可并行加工，R1的上下料和退位均互斥。
# 受限工艺DSL：用 tools/check_flows.py 检查，不直接执行此文件。

async def handle_job_1(job):
    await wait.input_present(job.material, job.input, timeout=ticks(1800))
    async with resources(C1):
        await C1.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.target_available(job.work, timeout=ticks(1800))
    async with resources(job.machine):
        async with resources(R1, C1):
            await R1.transfer_material(material=job.material, source=C1.exit, target=job.work)
            await R1.move_to_location(target=R1.home)
        await job.machine.clamp(material=job.material)
        await job.machine.process_material(material=job.material, recipe=job.recipe)
        await job.machine.unclamp(material=job.material)
        await wait.target_available(C2.entry, timeout=ticks(1800))
        async with resources(R1, C2):
            await R1.transfer_material(material=job.material, source=job.work, target=C2.entry)
            await R1.move_to_location(target=R1.home)
    async with resources(C2):
        await C2.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.output_departed(job.material, C2, timeout=ticks(1800))


@process(version="ac-python/0.1", scene="S09")
async def main():
    await parallel_for(batch.jobs, handle_job_1, max_active=2)
    await verify('batch_goal')

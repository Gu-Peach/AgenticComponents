# 四件双机械臂双输送带流水交接
# 最多2件在途，上游准备可与下游出料重叠；共享设备和目标容量互锁。
# 受限工艺DSL：用 tools/check_flows.py 检查，不直接执行此文件。

async def handle_job_1(job):
    await wait.input_present(job.material, job.input, timeout=ticks(1800))
    await wait.target_available(C1.entry, timeout=ticks(1800))
    async with resources(R1, S, C1):
        await R1.transfer_material(material=job.material, source=job.input, target=C1.entry)
        await R1.move_to_location(target=R1.home)
    async with resources(C1):
        await C1.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.target_available(C2.entry, timeout=ticks(1800))
    async with resources(R2, C1, C2):
        await R2.transfer_material(material=job.material, source=C1.exit, target=C2.entry)
        await R2.move_to_location(target=R2.home)
    async with resources(C2):
        await C2.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.output_departed(job.material, C2, timeout=ticks(1800))


@process(version="ac-python/0.1", scene="S04")
async def main():
    await parallel_for(batch.jobs, handle_job_1, max_active=2)
    await verify('batch_goal')

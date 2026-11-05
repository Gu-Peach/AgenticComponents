# 四件双侧加工与转位交接流水
# 最多2件在途，PS1与PS2可加工不同工件，转台交接周期互斥。
# 受限工艺DSL：用 tools/check_flows.py 检查，不直接执行此文件。

async def handle_job_1(job):
    await wait.input_present(job.material, job.input, timeout=ticks(1800))
    async with resources(C1):
        await C1.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.target_available(PS1.work, timeout=ticks(1800))
    async with resources(PS1):
        async with resources(R1, C1):
            await R1.transfer_material(material=job.material, source=C1.exit, target=PS1.work)
            await R1.move_to_location(target=R1.home)
        await PS1.clamp(material=job.material)
        await PS1.process_material(material=job.material, recipe='side_a')
        await PS1.unclamp(material=job.material)
        await wait.target_available(PS2.work, timeout=ticks(1800))
        async with resources(T1, R1, R2, PS2):
            await R1.transfer_material(material=job.material, source=PS1.work, target=T1.slot1)
            await R1.move_to_location(target=R1.home)
            await T1.index_to_angle(angle=quantity(3.141592653589793, 'rad'))
            await R2.transfer_material(material=job.material, source=T1.slot1, target=PS2.work)
            await R2.move_to_location(target=R2.home)
            await T1.index_to_angle(angle=quantity(0.0, 'rad'))
    async with resources(PS2):
        await PS2.clamp(material=job.material)
        await PS2.process_material(material=job.material, recipe='side_b')
        await PS2.unclamp(material=job.material)
        await wait.target_available(C2.entry, timeout=ticks(1800))
        async with resources(R2, C2):
            await R2.transfer_material(material=job.material, source=PS2.work, target=C2.entry)
            await R2.move_to_location(target=R2.home)
    async with resources(C2):
        await C2.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
    await wait.output_departed(job.material, C2, timeout=ticks(1800))


@process(version="ac-python/0.1", scene="S12")
async def main():
    await parallel_for(batch.jobs, handle_job_1, max_active=2)
    await verify('batch_goal')

# 四件双机器人去毛刺闭环
# 共用同一条进出料输送带，逐件循环；不假定存在独立回流通道。
# 受限工艺DSL：用 tools/check_flows.py 检查，不直接执行此文件。

@process(version="ac-python/0.1", scene="S05")
async def main():
    for job in batch.jobs:
        await wait.input_present(job.material, job.input, timeout=ticks(1800))
        async with resources(C1):
            await C1.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
        async with resources(R1, C1, F1):
            await R1.transfer_material(material=job.material, source=C1.exit, target=F1.work)
            await R1.move_to_location(target=R1.home)
        async with resources(R2, F1, D1):
            await R2.transfer_material(material=job.material, source=F1.work, target=D1.work)
            await R2.move_to_location(target=R2.home)
        async with resources(D1):
            await D1.clamp(material=job.material)
            await D1.process_material(material=job.material, recipe='deburr')
            await D1.unclamp(material=job.material)
        async with resources(R2, D1, C1):
            await R2.transfer_material(material=job.material, source=D1.work, target=C1.entry)
            await R2.move_to_location(target=R2.home)
        async with resources(C1):
            await C1.transport_to_exit(material=job.material, speed_mps=quantity(0.2, 'm/s'))
        await wait.output_departed(job.material, C1, timeout=ticks(1800))
    await verify('batch_goal')

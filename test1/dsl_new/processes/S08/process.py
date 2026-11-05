# 四件L形加工工位流水
# 行为前后条件由契约自动处理；工艺只声明动作与协作关系。
with process('S08', version='ac-declarative/0.3'):
    with seq('batch_root'):
        with par('machining_pipeline_207', join='all'):
            with repeat('infeed_188', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('infeed_body_187'):
                    invoke('c1_transport_to_exit_186', C1, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c1_transport_to_exit_186_stop', C1, 'stop_conveying')
            with repeat('machine_cell_201', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('machine_cell_body_200'):
                    invoke('r1_transfer_material_190', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=C1.exit, target=MC1.work))
                    invoke('r1_move_to_location_191', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                    invoke('mc1_clamp_193', MC1, 'clamp', material=job.material)
                    invoke('mc1_process_material_194', MC1, 'process_material', material=job.material, recipe='machining')
                    invoke('mc1_unclamp_195', MC1, 'unclamp', material=job.material)
                    invoke('r1_transfer_material_197', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=MC1.work, target=C2.entry))
                    invoke('r1_move_to_location_198', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
            with repeat('outfeed_206', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('outfeed_body_205'):
                    invoke('c2_transport_to_exit_203', C2, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c2_transport_to_exit_203_stop', C2, 'stop_conveying')
                    invoke('output_departed_204_release', C2, 'release_material', subject_id=subject_id(job.material))
                    invoke('output_departed_204_stop', C2, 'stop_conveying')

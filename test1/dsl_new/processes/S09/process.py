# 六件双机加工与单机器人互斥服务
# 行为前后条件由契约自动处理；工艺只声明动作与协作关系。
with process('S09', version='ac-declarative/0.3'):
    with seq('batch_root'):
        with par('dual_machine_244', join='all'):
            with repeat('infeed_213', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('infeed_body_212'):
                    invoke('c1_transport_to_exit_211', C1, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c1_transport_to_exit_211_stop', C1, 'stop_conveying')
            with repeat('MC1_jobs_228', over=select(batch.jobs, machine=MC1), bind='job', limit=batch.material_count):
                with seq('MC1_jobs_body_227'):
                    invoke('r1_transfer_material_215', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=C1.exit, target=MC1.work))
                    invoke('r1_move_to_location_216', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                    invoke('mc1_clamp_218', MC1, 'clamp', material=job.material)
                    invoke('mc1_process_material_219', MC1, 'process_material', material=job.material, recipe='machining_a')
                    invoke('mc1_unclamp_220', MC1, 'unclamp', material=job.material)
                    invoke('r1_transfer_material_222', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=MC1.work, target=C2.entry))
                    invoke('r1_move_to_location_223', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                    invoke('c2_transport_to_exit_225', C2, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c2_transport_to_exit_225_stop', C2, 'stop_conveying')
                    invoke('output_departed_226_release', C2, 'release_material', subject_id=subject_id(job.material))
                    invoke('output_departed_226_stop', C2, 'stop_conveying')
            with repeat('MC2_jobs_243', over=select(batch.jobs, machine=MC2), bind='job', limit=batch.material_count):
                with seq('MC2_jobs_body_242'):
                    invoke('r1_transfer_material_230', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=C1.exit, target=MC2.work))
                    invoke('r1_move_to_location_231', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                    invoke('mc2_clamp_233', MC2, 'clamp', material=job.material)
                    invoke('mc2_process_material_234', MC2, 'process_material', material=job.material, recipe='machining_b')
                    invoke('mc2_unclamp_235', MC2, 'unclamp', material=job.material)
                    invoke('r1_transfer_material_237', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=MC2.work, target=C2.entry))
                    invoke('r1_move_to_location_238', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                    invoke('c2_transport_to_exit_240', C2, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c2_transport_to_exit_240_stop', C2, 'stop_conveying')
                    invoke('output_departed_241_release', C2, 'release_material', subject_id=subject_id(job.material))
                    invoke('output_departed_241_stop', C2, 'stop_conveying')

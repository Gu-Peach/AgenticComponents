# Scene assets are resolved from device; this is data-only DSL.
with process('S09', version='ac-declarative/0.4', devices='./device', task=production(jobs=[{'id': 'J01', 'material': 'M01', 'input': 'C1.entry', 'machine': 'MC1', 'work': 'MC1.work', 'recipe': 'machining_a', 'target': 'C2.exit'}, {'id': 'J02', 'material': 'M02', 'input': 'C1.entry', 'machine': 'MC2', 'work': 'MC2.work', 'recipe': 'machining_b', 'target': 'C2.exit'}, {'id': 'J03', 'material': 'M03', 'input': 'C1.entry', 'machine': 'MC1', 'work': 'MC1.work', 'recipe': 'machining_a', 'target': 'C2.exit'}, {'id': 'J04', 'material': 'M04', 'input': 'C1.entry', 'machine': 'MC2', 'work': 'MC2.work', 'recipe': 'machining_b', 'target': 'C2.exit'}, {'id': 'J05', 'material': 'M05', 'input': 'C1.entry', 'machine': 'MC1', 'work': 'MC1.work', 'recipe': 'machining_a', 'target': 'C2.exit'}, {'id': 'J06', 'material': 'M06', 'input': 'C1.entry', 'machine': 'MC2', 'work': 'MC2.work', 'recipe': 'machining_b', 'target': 'C2.exit'}], pallets=[]), goal='./task-spec.json'):
    with seq('batch_root'):
        with par('dual_machine_244', join='all'):
            with repeat('infeed_213', over=task.jobs, bind='job', limit=task.material_count):
                with seq('infeed_body_212'):
                    invoke('c1_transport_to_exit_211', C1, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c1_transport_to_exit_211_stop', C1, 'stop_conveying')
            with repeat('MC1_jobs_228', over=select(task.jobs, machine=MC1), bind='job', limit=task.material_count):
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
            with repeat('MC2_jobs_243', over=select(task.jobs, machine=MC2), bind='job', limit=task.material_count):
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

# 四件双侧加工与转位交接流水
# 行为前后条件由契约自动处理；工艺只声明动作与协作关系。
with process('S12', version='ac-declarative/0.3'):
    with seq('batch_root'):
        with par('two_sided_pipeline_322', join='all'):
            with repeat('infeed_316', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('infeed_body_315'):
                    invoke('c1_transport_to_exit_314', C1, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c1_transport_to_exit_314_stop', C1, 'stop_conveying')
            with repeat('side_a_290', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('side_a_body_289'):
                    invoke('r1_transfer_material_282', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=C1.exit, target=PS1.work))
                    invoke('r1_move_to_location_283', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                    invoke('ps1_clamp_285', PS1, 'clamp', material=job.material)
                    invoke('ps1_process_material_286', PS1, 'process_material', material=job.material, recipe='side_a')
                    invoke('ps1_unclamp_287', PS1, 'unclamp', material=job.material)
                    invoke('r1_transfer_material_293', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=PS1.work, target=T1.slot1))
                    invoke('r1_move_to_location_294', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                    invoke('t1_index_to_angle_296', T1, 'rotate_to_station', angleTag=quantity(180.0, '°'))
                    invoke('r2_transfer_material_297', R2, 'pick_and_place', payload=payload('R2.pick_and_place', material=job.material, source=T1.slot1, target=PS2.work))
                    invoke('r2_move_to_location_298', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
                    invoke('t1_index_to_angle_300', T1, 'rotate_to_station', angleTag=quantity(0.0, '°'))
            with repeat('side_b_312', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('side_b_body_311'):
                    invoke('ps2_clamp_304', PS2, 'clamp', material=job.material)
                    invoke('ps2_process_material_305', PS2, 'process_material', material=job.material, recipe='side_b')
                    invoke('ps2_unclamp_306', PS2, 'unclamp', material=job.material)
                    invoke('r2_transfer_material_308', R2, 'pick_and_place', payload=payload('R2.pick_and_place', material=job.material, source=PS2.work, target=C2.entry))
                    invoke('r2_move_to_location_309', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
            with repeat('outfeed_321', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('outfeed_body_320'):
                    invoke('c2_transport_to_exit_318', C2, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c2_transport_to_exit_318_stop', C2, 'stop_conveying')
                    invoke('output_departed_319_release', C2, 'release_material', subject_id=subject_id(job.material))
                    invoke('output_departed_319_stop', C2, 'stop_conveying')

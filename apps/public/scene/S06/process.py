# Scene assets are resolved from device; this is data-only DSL.
with process('S06', version='ac-declarative/0.4', devices='./device', task=production(jobs=[{'id': 'J01', 'material': 'M01', 'input': 'C1.entry', 'target': 'C3.exit'}, {'id': 'J02', 'material': 'M02', 'input': 'C1.entry', 'target': 'C3.exit'}, {'id': 'J03', 'material': 'M03', 'input': 'C1.entry', 'target': 'C3.exit'}, {'id': 'J04', 'material': 'M04', 'input': 'C1.entry', 'target': 'C3.exit'}], pallets=[]), goal='./task-spec.json'):
    with seq('batch_root'):
        with par('table_pipeline_149', join='all'):
            with repeat('infeed_143', over=task.jobs, bind='job', limit=task.material_count):
                with seq('infeed_body_142'):
                    invoke('c1_transport_to_exit_141', C1, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c1_transport_to_exit_141_stop', C1, 'stop_conveying')
            with repeat('table_cell_139', over=task.jobs, bind='job', limit=task.material_count):
                with seq('table_cell_body_138'):
                    invoke('r1_transfer_material_130', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=C1.exit, target=T1.slot1))
                    invoke('r1_move_to_location_131', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                    invoke('t1_index_to_angle_133', T1, 'rotate_to_station', angleTag=quantity(180.0, '°'))
                    invoke('r2_transfer_material_134', R2, 'pick_and_place', payload=payload('R2.pick_and_place', material=job.material, source=T1.slot1, target=C3.entry))
                    invoke('r2_move_to_location_135', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
                    invoke('t1_index_to_angle_137', T1, 'rotate_to_station', angleTag=quantity(0.0, '°'))
            with repeat('output_148', over=task.jobs, bind='job', limit=task.material_count):
                with seq('output_body_147'):
                    invoke('c3_transport_to_exit_145', C3, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c3_transport_to_exit_145_stop', C3, 'stop_conveying')
                    invoke('output_departed_146_release', C3, 'release_material', subject_id=subject_id(job.material))
                    invoke('output_departed_146_stop', C3, 'stop_conveying')

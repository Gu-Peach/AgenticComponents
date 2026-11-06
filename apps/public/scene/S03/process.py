# Scene assets are resolved from device; this is data-only DSL.
with process('S03', version='ac-declarative/0.4', devices='./device', task=production(jobs=[{'id': 'J01', 'material': 'M01', 'input': 'IN.entry', 'target': 'OUT.exit'}, {'id': 'J02', 'material': 'M02', 'input': 'IN.entry', 'target': 'OUT.exit'}, {'id': 'J03', 'material': 'M03', 'input': 'IN.entry', 'target': 'OUT.exit'}, {'id': 'J04', 'material': 'M04', 'input': 'IN.entry', 'target': 'OUT.exit'}, {'id': 'J05', 'material': 'M05', 'input': 'IN.entry', 'target': 'OUT.exit'}, {'id': 'J06', 'material': 'M06', 'input': 'IN.entry', 'target': 'OUT.exit'}], pallets=[]), goal='./task-spec.json'):
    with seq('batch_root'):
        with par('pipeline_082', join='all'):
            with repeat('load_069', over=task.jobs, bind='job', limit=task.material_count):
                with seq('load_body_068'):
                    invoke('in_transport_to_exit_064', IN, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('in_transport_to_exit_064_stop', IN, 'stop_conveying')
                    invoke('r1_transfer_material_065', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=IN.exit, target=LOOP.entry))
                    invoke('r1_move_to_location_066', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
            with repeat('middle_transport_073', over=task.jobs, bind='job', limit=task.material_count):
                with seq('middle_transport_body_072'):
                    invoke('loop_transport_to_exit_071', LOOP, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('loop_transport_to_exit_071_stop', LOOP, 'stop_conveying')
            with repeat('unload_081', over=task.jobs, bind='job', limit=task.material_count):
                with seq('unload_body_080'):
                    invoke('r2_transfer_material_075', R2, 'pick_and_place', payload=payload('R2.pick_and_place', material=job.material, source=LOOP.exit, target=OUT.entry))
                    invoke('r2_move_to_location_076', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
                    invoke('out_transport_to_exit_078', OUT, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('out_transport_to_exit_078_stop', OUT, 'stop_conveying')
                    invoke('output_departed_079_release', OUT, 'release_material', subject_id=subject_id(job.material))
                    invoke('output_departed_079_stop', OUT, 'stop_conveying')

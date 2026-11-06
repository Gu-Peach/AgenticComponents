# Scene assets are resolved from device; this is data-only DSL.
with process('S04', version='ac-declarative/0.4', devices='./device', task=production(jobs=[{'id': 'J01', 'material': 'M01', 'input': 'S.work', 'target': 'C2.exit'}, {'id': 'J02', 'material': 'M02', 'input': 'S.work', 'target': 'C2.exit'}, {'id': 'J03', 'material': 'M03', 'input': 'S.work', 'target': 'C2.exit'}, {'id': 'J04', 'material': 'M04', 'input': 'S.work', 'target': 'C2.exit'}], pallets=[]), goal='./task-spec.json'):
    with seq('batch_root'):
        with par('pipeline_103', join='all'):
            with repeat('load_090', over=task.jobs, bind='job', limit=task.material_count):
                with seq('transfer_088'):
                    invoke('r1_transfer_material_086', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=job.material, source=job.input, target=C1.entry))
                    invoke('r1_move_to_location_087', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
            with repeat('middle_transport_094', over=task.jobs, bind='job', limit=task.material_count):
                with seq('middle_transport_body_093'):
                    invoke('c1_transport_to_exit_092', C1, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c1_transport_to_exit_092_stop', C1, 'stop_conveying')
            with repeat('unload_102', over=task.jobs, bind='job', limit=task.material_count):
                with seq('unload_body_101'):
                    invoke('r2_transfer_material_096', R2, 'pick_and_place', payload=payload('R2.pick_and_place', material=job.material, source=C1.exit, target=C2.entry))
                    invoke('r2_move_to_location_097', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
                    invoke('c2_transport_to_exit_099', C2, 'transport_to_exit', subject_id=subject_id(job.material))
                    invoke('c2_transport_to_exit_099_stop', C2, 'stop_conveying')
                    invoke('output_departed_100_release', C2, 'release_material', subject_id=subject_id(job.material))
                    invoke('output_departed_100_stop', C2, 'stop_conveying')

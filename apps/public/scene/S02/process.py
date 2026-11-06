# Scene assets are resolved from device; this is data-only DSL.
with process('S02', version='ac-declarative/0.4', devices='./device', task=production(jobs=[], pallets=[{'id': 'P01', 'items': [{'material': 'M01_1', 'source': 'P01.slot1'}, {'material': 'M01_2', 'source': 'P01.slot2'}, {'material': 'M01_3', 'source': 'P01.slot3'}, {'material': 'M01_4', 'source': 'P01.slot4'}], 'initial': 'carrier_infeed', 'target': 'C1.exit'}, {'id': 'P02', 'items': [{'material': 'M02_1', 'source': 'P02.slot1'}, {'material': 'M02_2', 'source': 'P02.slot2'}, {'material': 'M02_3', 'source': 'P02.slot3'}, {'material': 'M02_4', 'source': 'P02.slot4'}], 'initial': 'carrier_infeed', 'target': 'C1.exit'}, {'id': 'P03', 'items': [{'material': 'M03_1', 'source': 'P03.slot1'}, {'material': 'M03_2', 'source': 'P03.slot2'}, {'material': 'M03_3', 'source': 'P03.slot3'}, {'material': 'M03_4', 'source': 'P03.slot4'}], 'initial': 'carrier_infeed', 'target': 'C1.exit'}, {'id': 'P04', 'items': [{'material': 'M04_1', 'source': 'P04.slot1'}, {'material': 'M04_2', 'source': 'P04.slot2'}, {'material': 'M04_3', 'source': 'P04.slot3'}, {'material': 'M04_4', 'source': 'P04.slot4'}], 'initial': 'carrier_infeed', 'target': 'C1.exit'}, {'id': 'P05', 'items': [{'material': 'M05_1', 'source': 'P05.slot1'}, {'material': 'M05_2', 'source': 'P05.slot2'}, {'material': 'M05_3', 'source': 'P05.slot3'}, {'material': 'M05_4', 'source': 'P05.slot4'}], 'initial': 'carrier_infeed', 'target': 'C1.exit'}, {'id': 'P06', 'items': [{'material': 'M06_1', 'source': 'P06.slot1'}, {'material': 'M06_2', 'source': 'P06.slot2'}, {'material': 'M06_3', 'source': 'P06.slot3'}, {'material': 'M06_4', 'source': 'P06.slot4'}], 'initial': 'carrier_infeed', 'target': 'C1.exit'}]), goal='./task-spec.json'):
    with seq('batch_root'):
        with repeat('waves_060', over=chunks(task.pallets, size=3), bind='wave', limit=task.pallet_count):
            with seq('waves_body_059'):
                with repeat('c1_index_carriers_054_three_pitches', count=3):
                    invoke('c1_index_carriers_054_pitch', C1, 'move_by_distance', distance_m=calibration(C1, 'pitch_m'))
                with par('unload_wave_055', join='all'):
                    with repeat('R1_pallet_items_033', over=items_at(C1.station1), bind='part1', limit=task.max_items_per_pallet):
                        with seq('R1_pallet_items_body_032'):
                            invoke('r1_transfer_material_027', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=part1.material, source=part1.source, target=C2.entry))
                            invoke('r1_move_to_location_028', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                            invoke('c2_transport_to_exit_030', C2, 'transport_to_exit', subject_id=subject_id(part1.material))
                            invoke('c2_transport_to_exit_030_stop', C2, 'stop_conveying')
                            invoke('output_departed_031_release', C2, 'release_material', subject_id=subject_id(part1.material))
                            invoke('output_departed_031_stop', C2, 'stop_conveying')
                    with repeat('R2_pallet_items_042', over=items_at(C1.station2), bind='part2', limit=task.max_items_per_pallet):
                        with seq('R2_pallet_items_body_041'):
                            invoke('r2_transfer_material_036', R2, 'pick_and_place', payload=payload('R2.pick_and_place', material=part2.material, source=part2.source, target=C3.entry))
                            invoke('r2_move_to_location_037', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
                            invoke('c3_transport_to_exit_039', C3, 'transport_to_exit', subject_id=subject_id(part2.material))
                            invoke('c3_transport_to_exit_039_stop', C3, 'stop_conveying')
                            invoke('output_departed_040_release', C3, 'release_material', subject_id=subject_id(part2.material))
                            invoke('output_departed_040_stop', C3, 'stop_conveying')
                    with repeat('R3_pallet_items_051', over=items_at(C1.station3), bind='part3', limit=task.max_items_per_pallet):
                        with seq('R3_pallet_items_body_050'):
                            invoke('r3_transfer_material_045', R3, 'pick_and_place', payload=payload('R3.pick_and_place', material=part3.material, source=part3.source, target=C4.entry))
                            invoke('r3_move_to_location_046', R3, 'move_to_pose', payload=payload('R3.move_to_pose', target=R3.home))
                            invoke('c4_transport_to_exit_048', C4, 'transport_to_exit', subject_id=subject_id(part3.material))
                            invoke('c4_transport_to_exit_048_stop', C4, 'stop_conveying')
                            invoke('output_departed_049_release', C4, 'release_material', subject_id=subject_id(part3.material))
                            invoke('output_departed_049_stop', C4, 'stop_conveying')
                with repeat('c1_index_carriers_057_three_pitches', count=3):
                    invoke('c1_index_carriers_057_pitch', C1, 'move_by_distance', distance_m=calibration(C1, 'pitch_m'))

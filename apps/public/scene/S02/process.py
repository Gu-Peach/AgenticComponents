# 六托盘三工位成组并行拆垛与空盘出线
# 行为前后条件由契约自动处理；工艺只声明动作与协作关系。
with process('S02', version='ac-declarative/0.3'):
    with seq('batch_root'):
        with repeat('waves_060', over=chunks(batch.pallets, size=3), bind='wave', limit=batch.pallet_count):
            with seq('waves_body_059'):
                with repeat('c1_index_carriers_054_three_pitches', count=3):
                    invoke('c1_index_carriers_054_pitch', C1, 'move_by_distance', distance_m=calibration(C1, 'pitch_m'))
                with par('unload_wave_055', join='all'):
                    with repeat('R1_pallet_items_033', over=items_at(C1.station1), bind='part1', limit=batch.max_items_per_pallet):
                        with seq('R1_pallet_items_body_032'):
                            invoke('r1_transfer_material_027', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=part1.material, source=part1.source, target=C2.entry))
                            invoke('r1_move_to_location_028', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                            invoke('c2_transport_to_exit_030', C2, 'transport_to_exit', subject_id=subject_id(part1.material))
                            invoke('c2_transport_to_exit_030_stop', C2, 'stop_conveying')
                            invoke('output_departed_031_release', C2, 'release_material', subject_id=subject_id(part1.material))
                            invoke('output_departed_031_stop', C2, 'stop_conveying')
                    with repeat('R2_pallet_items_042', over=items_at(C1.station2), bind='part2', limit=batch.max_items_per_pallet):
                        with seq('R2_pallet_items_body_041'):
                            invoke('r2_transfer_material_036', R2, 'pick_and_place', payload=payload('R2.pick_and_place', material=part2.material, source=part2.source, target=C3.entry))
                            invoke('r2_move_to_location_037', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
                            invoke('c3_transport_to_exit_039', C3, 'transport_to_exit', subject_id=subject_id(part2.material))
                            invoke('c3_transport_to_exit_039_stop', C3, 'stop_conveying')
                            invoke('output_departed_040_release', C3, 'release_material', subject_id=subject_id(part2.material))
                            invoke('output_departed_040_stop', C3, 'stop_conveying')
                    with repeat('R3_pallet_items_051', over=items_at(C1.station3), bind='part3', limit=batch.max_items_per_pallet):
                        with seq('R3_pallet_items_body_050'):
                            invoke('r3_transfer_material_045', R3, 'pick_and_place', payload=payload('R3.pick_and_place', material=part3.material, source=part3.source, target=C4.entry))
                            invoke('r3_move_to_location_046', R3, 'move_to_pose', payload=payload('R3.move_to_pose', target=R3.home))
                            invoke('c4_transport_to_exit_048', C4, 'transport_to_exit', subject_id=subject_id(part3.material))
                            invoke('c4_transport_to_exit_048_stop', C4, 'stop_conveying')
                            invoke('output_departed_049_release', C4, 'release_material', subject_id=subject_id(part3.material))
                            invoke('output_departed_049_stop', C4, 'stop_conveying')
                with repeat('c1_index_carriers_057_three_pitches', count=3):
                    invoke('c1_index_carriers_057_pitch', C1, 'move_by_distance', distance_m=calibration(C1, 'pitch_m'))

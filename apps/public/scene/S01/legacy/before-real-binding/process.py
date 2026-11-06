# Scene assets are resolved from device; this is data-only DSL.
with process('S01', version='ac-declarative/0.4', devices='./device', task=production(jobs=[], pallets=[{'id': 'P01', 'items': [{'material': 'M01_1', 'category': 'A', 'source': 'P01.slot1'}, {'material': 'M01_2', 'category': 'B', 'source': 'P01.slot2'}, {'material': 'M01_3', 'category': 'A', 'source': 'P01.slot3'}, {'material': 'M01_4', 'category': 'B', 'source': 'P01.slot4'}]}, {'id': 'P02', 'items': [{'material': 'M02_1', 'category': 'A', 'source': 'P02.slot1'}, {'material': 'M02_2', 'category': 'B', 'source': 'P02.slot2'}, {'material': 'M02_3', 'category': 'A', 'source': 'P02.slot3'}, {'material': 'M02_4', 'category': 'B', 'source': 'P02.slot4'}]}, {'id': 'P03', 'items': [{'material': 'M03_1', 'category': 'A', 'source': 'P03.slot1'}, {'material': 'M03_2', 'category': 'B', 'source': 'P03.slot2'}, {'material': 'M03_3', 'category': 'A', 'source': 'P03.slot3'}, {'material': 'M03_4', 'category': 'B', 'source': 'P03.slot4'}]}]), goal='./task-spec.json'):
    with seq('batch_001'):
        with repeat('line_cycles_002', count=task.pallet_count + 2):
            with seq('line_cycle_003'):
                invoke('line_advance_005', C1, 'move_by_distance', distance_m=calibration(C1, 'pitch_m'))
                with par('station_work_008', join='all'):
                    with repeat('items_A_011', over=items_at(C1.station1, category='A'), bind='a', limit=task.max_items_per_pallet):
                        with seq('item_A_012'):
                            invoke('pick_place_A_013', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=a.material, source=a.source, target=C2.entry))
                            invoke('retreat_A_014', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))
                            invoke('outfeed_A_015', C2, 'transport_to_exit', subject_id=subject_id(a.material))
                            invoke('handoff_A_018', C2, 'release_material', subject_id=subject_id(a.material))
                            invoke('stop_A_019', C2, 'stop_conveying')
                    with repeat('items_B_021', over=items_at(C1.station2, category='B'), bind='b', limit=task.max_items_per_pallet):
                        with seq('item_B_022'):
                            invoke('pick_place_B_023', R2, 'pick_and_place', payload=payload('R2.pick_and_place', material=b.material, source=b.source, target=C3.entry))
                            invoke('retreat_B_024', R2, 'move_to_pose', payload=payload('R2.move_to_pose', target=R2.home))
                            invoke('outfeed_B_025', C3, 'transport_to_exit', subject_id=subject_id(b.material))
                            invoke('handoff_B_028', C3, 'release_material', subject_id=subject_id(b.material))
                            invoke('stop_B_029', C3, 'stop_conveying')

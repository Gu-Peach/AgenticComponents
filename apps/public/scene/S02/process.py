# 六盘顺序入线；每盘在三个工位分别装下层料、盖板和上层料。
with process('S02', version='ac-declarative/0.4', devices='./device',
             task=production(carrier_template='Pallet', count=6), goal='./task-spec.json'):
    with seq('batch'):
        with repeat('pallet_cycles', over=task.pallets, bind='pallet', limit=task.pallet_count):
            with seq('load_pallet'):
                invoke('index_to_lower', C5, 'transport_to_position',
                       subject_id=subject_id(pallet.id), target=C5.station1)
                with repeat('lower_items', over=select(pallet.items, category='lower'),
                            bind='part', limit=task.max_items_per_pallet):
                    with seq('place_lower_item'):
                        invoke('feed_lower', S1B, 'transport_to_position',
                               subject_id=subject_id(part.material), target=S1B.pick)
                        invoke('place_lower', R1, 'pick_and_place',
                               payload=payload('R1.pick_and_place', material=part.material,
                                               source=S1B.pick, target=part.target))
                        invoke('retreat_lower', R1, 'move_to_pose',
                               payload=payload('R1.move_to_pose', target=R1.home))
                invoke('index_to_cover', C5, 'transport_to_position',
                       subject_id=subject_id(pallet.id), target=C5.station2)
                with repeat('cover_items', over=select(pallet.items, category='cover'),
                            bind='part', limit=task.max_items_per_pallet):
                    with seq('place_cover_item'):
                        invoke('feed_cover', S2B, 'transport_to_position',
                               subject_id=subject_id(part.material), target=S2B.pick)
                        invoke('place_cover', R2, 'pick_and_place',
                               payload=payload('R2.pick_and_place', material=part.material,
                                               source=S2B.pick, target=part.target))
                        invoke('retreat_cover', R2, 'move_to_pose',
                               payload=payload('R2.move_to_pose', target=R2.home))
                invoke('index_to_upper', C5, 'transport_to_position',
                       subject_id=subject_id(pallet.id), target=C5.station3)
                with repeat('upper_items', over=select(pallet.items, category='upper'),
                            bind='part', limit=task.max_items_per_pallet):
                    with seq('place_upper_item'):
                        invoke('feed_upper', S3B, 'transport_to_position',
                               subject_id=subject_id(part.material), target=S3B.pick)
                        invoke('place_upper', R3, 'pick_and_place',
                               payload=payload('R3.pick_and_place', material=part.material,
                                               source=S3B.pick, target=part.target))
                        invoke('retreat_upper', R3, 'move_to_pose',
                               payload=payload('R3.move_to_pose', target=R3.home))
                invoke('move_loaded_pallet_to_exit', C5, 'transport_to_position',
                       subject_id=subject_id(pallet.id), target=C5.exit)
                invoke('release_loaded_pallet', C5, 'release_material',
                       subject_id=subject_id(pallet.id))
                invoke('stop_mainline', C5, 'stop_conveying')

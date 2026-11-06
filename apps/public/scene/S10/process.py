# Scene assets are resolved from device; this is data-only DSL.
with process('S10', version='ac-declarative/0.4', devices='./device', task=production(jobs=[], pallets=[{'id': 'P01', 'items': [{'material': 'M01_1', 'input': 'C1.entry', 'target': 'P01.slot1'}, {'material': 'M01_2', 'input': 'C1.entry', 'target': 'P01.slot2'}, {'material': 'M01_3', 'input': 'C1.entry', 'target': 'P01.slot3'}, {'material': 'M01_4', 'input': 'C1.entry', 'target': 'P01.slot4'}]}, {'id': 'P02', 'items': [{'material': 'M02_1', 'input': 'C1.entry', 'target': 'P02.slot1'}, {'material': 'M02_2', 'input': 'C1.entry', 'target': 'P02.slot2'}, {'material': 'M02_3', 'input': 'C1.entry', 'target': 'P02.slot3'}, {'material': 'M02_4', 'input': 'C1.entry', 'target': 'P02.slot4'}]}, {'id': 'P03', 'items': [{'material': 'M03_1', 'input': 'C1.entry', 'target': 'P03.slot1'}, {'material': 'M03_2', 'input': 'C1.entry', 'target': 'P03.slot2'}, {'material': 'M03_3', 'input': 'C1.entry', 'target': 'P03.slot3'}, {'material': 'M03_4', 'input': 'C1.entry', 'target': 'P03.slot4'}]}]), goal='./task-spec.json'):
    with seq('batch_root'):
        with repeat('pallet_orders_257', over=task.pallets, bind='pallet', limit=task.pallet_count):
            with repeat('fill_slots_253', over=pallet.items, bind='item', limit=task.max_items_per_pallet):
                with seq('fill_slots_body_252'):
                    invoke('c1_transport_to_exit_248', C1, 'transport_to_exit', subject_id=subject_id(item.material))
                    invoke('c1_transport_to_exit_248_stop', C1, 'stop_conveying')
                    invoke('r1_transfer_material_249', R1, 'pick_and_place', payload=payload('R1.pick_and_place', material=item.material, source=C1.exit, target=item.target))
                    invoke('r1_move_to_location_250', R1, 'move_to_pose', payload=payload('R1.move_to_pose', target=R1.home))

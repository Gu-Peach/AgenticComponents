# 轴目标用米计量。轨道相对各自零位，平台高度相对各自升降机基座。
with process('S07', version='ac-declarative/0.4', devices='./device', task=production(jobs=[
    {'id': 'J01', 'material': 'M01', 'prototype': 'Workpiece', 'input': 'C1.entry', 'slot': 'STORE.slot1', 'target': 'C2.exit', 'in_slot_position': -0.38306933, 'in_slot_height': 0.84, 'out_slot_position': -0.38306933, 'out_slot_height': 0.84},
    {'id': 'J02', 'material': 'M02', 'prototype': 'Workpiece', 'input': 'C1.entry', 'slot': 'STORE.slot2', 'target': 'C2.exit', 'in_slot_position': -0.38306933, 'in_slot_height': 1.44, 'out_slot_position': -0.38306933, 'out_slot_height': 1.44},
    {'id': 'J03', 'material': 'M03', 'prototype': 'Workpiece', 'input': 'C1.entry', 'slot': 'STORE.slot3', 'target': 'C2.exit', 'in_slot_position': -0.38306933, 'in_slot_height': 2.04, 'out_slot_position': -0.38306933, 'out_slot_height': 2.04},
    {'id': 'J04', 'material': 'M04', 'prototype': 'Workpiece', 'input': 'C1.entry', 'slot': 'STORE.slot4', 'target': 'C2.exit', 'in_slot_position': -0.38306933, 'in_slot_height': 2.64, 'out_slot_position': -0.38306933, 'out_slot_height': 2.64},
], pallets=[]), goal='./task-spec.json'):
    with seq('warehouse'):
        with repeat('store_orders', over=task.jobs, bind='job', limit=task.material_count):
            with seq('store_one'):
                invoke('infeed_to_exit', C1, 'transport_to_exit', subject_id=subject_id(job.material))
                invoke('infeed_stop', C1, 'stop_conveying')
                invoke('inbound_rail_to_dock', T1, 'move_to_position', position_m=quantity(-0.01753839, 'm'))
                invoke('inbound_lift_to_dock', L1, 'lift_to_level', move_to_level=quantity(0.54, 'm'))
                invoke('load_inbound_lift', L1, 'accept_material', payload=payload('L1.accept_material', material=job.material, source=C1.exit))
                invoke('inbound_rail_to_slot', T1, 'move_to_position', position_m=quantity(job.in_slot_position, 'm'))
                invoke('inbound_lift_to_slot', L1, 'lift_to_level', move_to_level=quantity(job.in_slot_height, 'm'))
                invoke('store_material', L1, 'release_material', payload=payload('L1.release_material', material=job.material, target=job.slot))
        with repeat('retrieve_orders', over=task.jobs, bind='job', limit=task.material_count):
            with seq('retrieve_one'):
                invoke('outbound_rail_to_slot', T2, 'move_to_position', position_m=quantity(job.out_slot_position, 'm'))
                invoke('outbound_lift_to_slot', L2, 'lift_to_level', move_to_level=quantity(job.out_slot_height, 'm'))
                invoke('retrieve_material', L2, 'accept_material', payload=payload('L2.accept_material', material=job.material, source=job.slot))
                invoke('outbound_rail_to_dock', T2, 'move_to_position', position_m=quantity(-2.01368335, 'm'))
                invoke('outbound_lift_to_dock', L2, 'lift_to_level', move_to_level=quantity(0.54, 'm'))
                invoke('unload_outbound_lift', L2, 'release_material', payload=payload('L2.release_material', material=job.material, target=C2.entry))
                invoke('outfeed_to_exit', C2, 'transport_to_exit', subject_id=subject_id(job.material))
                invoke('outfeed_release', C2, 'release_material', subject_id=subject_id(job.material))
                invoke('outfeed_stop', C2, 'stop_conveying')

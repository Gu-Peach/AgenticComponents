# 三托盘各四件的批次码垛与换盘
# 逐盘有限循环、盘内逐件码放、真实换盘确认后进入下一盘。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S10', version="ac-declarative/0.1"):
    with seq('batch_259'):
        with repeat('pallet_orders_257', over=batch.pallets, bind='pallet', limit=batch.pallet_count):
            with seq('pallet_orders_body_256'):
                wait_for('empty_pallet_present_254', fact('empty_pallet_present', pallet=pallet.id), timeout=seconds(30))
                with repeat('fill_slots_253', over=pallet.items, bind='item', limit=batch.max_items_per_pallet):
                    with seq('fill_slots_body_252'):
                        wait_for('input_present_247', fact('input_present', material=item.material, location=item.input), timeout=seconds(30))
                        invoke('c1_transport_to_exit_248', C1, 'transport_to_exit', material=item.material, speed_mps=quantity(0.2, "m/s"))
                        with seq('transfer_251'):
                            invoke('r1_transfer_material_249', R1, 'transfer_material', material=item.material, source=C1.exit, target=item.target)
                            invoke('r1_move_to_location_250', R1, 'move_to_location', target=R1.home)
                wait_for('full_pallet_departed_255', fact('full_pallet_departed', pallet=pallet.id), timeout=seconds(30))
        wait_for('batch_goal_satisfied_258', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))

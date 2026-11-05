# 三托盘分类拆垛与双绿色线出料
# 共同分度流水：每拍停稳后R1/R2处理不同托盘，全部退位后统一推进；3盘名义填充/排空需5拍。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S01', version="ac-declarative/0.1"):
    with seq('batch_025'):
        with repeat('line_cycles_023', count=batch.pallet_count + 2):
            with seq('line_cycles_body_022'):
                wait_for('line_ready_to_index_019', fact('line_ready_to_index', line=C1), timeout=seconds(30))
                invoke('c1_advance_pitch_020', C1, 'advance_pitch', inventory=batch.pallets)
                with par('station_work_021', join="all"):
                    with seq('R1_station_009'):
                        wait_for('station_inventory_valid_001', fact('station_inventory_valid', station=C1.station1), timeout=seconds(30))
                        with repeat('R1_items_008', over=items_at(C1.station1, category='A'), bind='a', limit=batch.max_items_per_pallet):
                            with seq('R1_items_body_007'):
                                with seq('transfer_004'):
                                    invoke('r1_transfer_material_002', R1, 'transfer_material', material=a.material, source=a.source, target=C2.entry)
                                    invoke('r1_move_to_location_003', R1, 'move_to_location', target=R1.home)
                                invoke('c2_transport_to_exit_005', C2, 'transport_to_exit', material=a.material, speed_mps=quantity(0.2, "m/s"))
                                wait_for('output_departed_006', fact('output_departed', material=a.material, device=C2), timeout=seconds(30))
                    with seq('R2_station_018'):
                        wait_for('station_inventory_valid_010', fact('station_inventory_valid', station=C1.station2), timeout=seconds(30))
                        with repeat('R2_items_017', over=items_at(C1.station2, category='B'), bind='b', limit=batch.max_items_per_pallet):
                            with seq('R2_items_body_016'):
                                with seq('transfer_013'):
                                    invoke('r2_transfer_material_011', R2, 'transfer_material', material=b.material, source=b.source, target=C3.entry)
                                    invoke('r2_move_to_location_012', R2, 'move_to_location', target=R2.home)
                                invoke('c3_transport_to_exit_014', C3, 'transport_to_exit', material=b.material, speed_mps=quantity(0.2, "m/s"))
                                wait_for('output_departed_015', fact('output_departed', material=b.material, device=C3), timeout=seconds(30))
        wait_for('batch_goal_satisfied_024', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))

# 六托盘按空闲工位分配、并行拆垛与空盘出线
# 三工位批组并行拆垛：显式主线入站→par三个工位→空盘出站；波次间有证据屏障。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S02', version="ac-declarative/0.1"):
    with seq('batch_062'):
        with repeat('waves_060', over=chunks(batch.pallets, size=3), bind='wave', limit=batch.pallet_count):
            with seq('waves_body_059'):
                wait_for('line_ready_to_index_053', fact('line_ready_to_index', line=C1), timeout=seconds(30))
                invoke('c1_index_carriers_054', C1, 'index_carriers', plan=carrier_plan(C1, wave, destinations=(C1.station1, C1.station2, C1.station3), mode="stations"))
                with par('unload_wave_055', join="all"):
                    with seq('R1_station_034'):
                        wait_for('station_inventory_valid_026', fact('station_inventory_valid', station=C1.station1), timeout=seconds(30))
                        with repeat('R1_pallet_items_033', over=items_at(C1.station1), bind='part1', limit=batch.max_items_per_pallet):
                            with seq('R1_pallet_items_body_032'):
                                with seq('transfer_029'):
                                    invoke('r1_transfer_material_027', R1, 'transfer_material', material=part1.material, source=part1.source, target=C2.entry)
                                    invoke('r1_move_to_location_028', R1, 'move_to_location', target=R1.home)
                                invoke('c2_transport_to_exit_030', C2, 'transport_to_exit', material=part1.material, speed_mps=quantity(0.2, "m/s"))
                                wait_for('output_departed_031', fact('output_departed', material=part1.material, device=C2), timeout=seconds(30))
                    with seq('R2_station_043'):
                        wait_for('station_inventory_valid_035', fact('station_inventory_valid', station=C1.station2), timeout=seconds(30))
                        with repeat('R2_pallet_items_042', over=items_at(C1.station2), bind='part2', limit=batch.max_items_per_pallet):
                            with seq('R2_pallet_items_body_041'):
                                with seq('transfer_038'):
                                    invoke('r2_transfer_material_036', R2, 'transfer_material', material=part2.material, source=part2.source, target=C3.entry)
                                    invoke('r2_move_to_location_037', R2, 'move_to_location', target=R2.home)
                                invoke('c3_transport_to_exit_039', C3, 'transport_to_exit', material=part2.material, speed_mps=quantity(0.2, "m/s"))
                                wait_for('output_departed_040', fact('output_departed', material=part2.material, device=C3), timeout=seconds(30))
                    with seq('R3_station_052'):
                        wait_for('station_inventory_valid_044', fact('station_inventory_valid', station=C1.station3), timeout=seconds(30))
                        with repeat('R3_pallet_items_051', over=items_at(C1.station3), bind='part3', limit=batch.max_items_per_pallet):
                            with seq('R3_pallet_items_body_050'):
                                with seq('transfer_047'):
                                    invoke('r3_transfer_material_045', R3, 'transfer_material', material=part3.material, source=part3.source, target=C4.entry)
                                    invoke('r3_move_to_location_046', R3, 'move_to_location', target=R3.home)
                                invoke('c4_transport_to_exit_048', C4, 'transport_to_exit', material=part3.material, speed_mps=quantity(0.2, "m/s"))
                                wait_for('output_departed_049', fact('output_departed', material=part3.material, device=C4), timeout=seconds(30))
                wait_for('wave_empty_and_clear_056', fact('wave_empty_and_clear', carriers=wave, line=C1), timeout=seconds(30))
                invoke('c1_index_carriers_057', C1, 'index_carriers', plan=carrier_plan(C1, wave, destinations=(C1.exit,), mode="exit"))
                wait_for('carriers_departed_058', fact('carriers_departed', carriers=wave), timeout=seconds(30))
        wait_for('batch_goal_satisfied_061', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))

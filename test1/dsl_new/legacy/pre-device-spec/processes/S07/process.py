# 四件分层入库后按订单出库
# 入库批次形成库存屏障；随后取货与出口输送并行，共享X1的动作由契约仲裁。
# 声明式控制图：通过专用前端检查，不作为Python脚本执行。
with process('S07', version="ac-declarative/0.1"):
    with seq('batch_184'):
        with seq('warehouse_182'):
            with repeat('store_orders_164', over=batch.jobs, bind='job', limit=batch.material_count):
                with seq('store_orders_body_163'):
                    wait_for('input_present_152', fact('input_present', material=job.material, location=job.input), timeout=seconds(30))
                    invoke('c1_transport_to_exit_153', C1, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                    invoke('l1_move_to_height_154', L1, 'move_to_height', height=quantity(0, "m"))
                    with seq('transfer_157'):
                        invoke('x1_transfer_material_155', X1, 'transfer_material', material=job.material, source=C1.exit, target=L1.work)
                        invoke('x1_move_to_location_156', X1, 'move_to_location', target=X1.home)
                    invoke('l1_move_to_height_158', L1, 'move_to_height', height=quantity(job.height, "m"))
                    with seq('transfer_161'):
                        invoke('x1_transfer_material_159', X1, 'transfer_material', material=job.material, source=L1.work, target=job.slot)
                        invoke('x1_move_to_location_160', X1, 'move_to_location', target=X1.home)
                    invoke('l1_move_to_height_162', L1, 'move_to_height', height=quantity(0, "m"))
            wait_for('inventory_stored_175', fact('inventory_stored', inventory=batch.jobs), timeout=seconds(30))
            with par('retrieve_and_outfeed_181', join="all"):
                with repeat('retrieve_orders_174', over=batch.jobs, bind='job', limit=batch.material_count):
                    with seq('retrieve_orders_body_173'):
                        invoke('l2_move_to_height_165', L2, 'move_to_height', height=quantity(job.height, "m"))
                        with seq('transfer_168'):
                            invoke('x1_transfer_material_166', X1, 'transfer_material', material=job.material, source=job.slot, target=L2.work)
                            invoke('x1_move_to_location_167', X1, 'move_to_location', target=X1.home)
                        invoke('l2_move_to_height_169', L2, 'move_to_height', height=quantity(0, "m"))
                        with seq('transfer_172'):
                            invoke('x1_transfer_material_170', X1, 'transfer_material', material=job.material, source=L2.work, target=C2.entry)
                            invoke('x1_move_to_location_171', X1, 'move_to_location', target=X1.home)
                with repeat('outfeed_180', over=batch.jobs, bind='job', limit=batch.material_count):
                    with seq('outfeed_body_179'):
                        wait_for('material_at_176', fact('material_at', material=job.material, location=C2.entry), timeout=seconds(30))
                        invoke('c2_transport_to_exit_177', C2, 'transport_to_exit', material=job.material, speed_mps=quantity(0.2, "m/s"))
                        wait_for('output_departed_178', fact('output_departed', material=job.material, device=C2), timeout=seconds(30))
        wait_for('batch_goal_satisfied_183', fact('batch_goal_satisfied', specification="task-spec.json"), timeout=seconds(30))

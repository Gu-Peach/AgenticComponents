# S07：双侧轨道升降仓储

模型入口为 `Intelligent Storage and Logistics Line/PM Stacker Cranes.glb`。已接入 `warehouse.virtual-linear@1` 候选仿真：导入 S07 → PLC → 准备候选仿真 → 运行。作者包保持 `executable=false`，准备阶段显式选择已实现的候选 profile，不代表实体硬件已标定。

| 实例 | 类型 | GLB 节点 | 职责 |
| --- | --- | --- | --- |
| C1 | conveyor | Conveyor_00In | 物料侧输送 |
| C2 | conveyor | Conveyor_#2_00Nn | 出口侧输送 |
| F1 | material_source_station | Feeder_00Kn | 有限任务供料 |
| T1 | linear_rail | Single_Rail_Transport_Controller_#2_009n | 入库侧水平定位；仅拥有 __Geometry___008c 的导轨网格 |
| L1 | lift_table | CraneA_00Bn | 由 T1 搭载；Z_00En 升降，虚拟直线接放料 |
| T2 | linear_rail | Single_Rail_Transport_Controller_#3_000n | 出库侧水平定位；仅拥有 __Geometry___000c 的导轨网格 |
| L2 | lift_table | CraneA_002n | 由 T2 搭载；Z_005n 升降，虚拟直线接放料 |
| STORE | storage_rack | Warehouse_Shelf_00Ln | 16 个被动格位 |

组合根是装配容器，不额外算作设备。轨道只拥有固定轨道几何，移动升降机子树归 L1/L2，运行时再分成机架和平台；Handler 保持在平台上的原始位姿。采用不可见运动学夹持点带动物料进行短距离直线交接，不模拟实体货叉伸缩。同一网格只允许一个物理所有者。

16 块承载板排列为 4 列 × 4 层。编号约定：列按场景世界 X 递减，每列由低到高编号，slot1–4 为第一列，slot5–8 为第二列，依此类推。四层承载面约为 1.0、1.6、2.2、2.8 m。位置取板面中心，属于几何候选位置，不是货叉目标。证据见 `evidence/s07-asset-binding.json` 和 `evidence/glb-node-geometry.json`。

`process.py` 使用 ac-declarative/0.4，保留原有四件任务和独立 `task-spec.json`：全部入库到 slot1–4 后，按订单取出并送至 C2.exit。入库依次执行 C1 输送停稳、T1/L1 对接定位、L1 接料、T1/L1 格位定位、L1 入库交接。出库由 T2/L2 完成，再由 C2 输送并交付。当前采用顺序出库基线，出口交接与容量尚未完成并发验证。

F1 由有限供料环境服务按 task.jobs 身份和 C1 容量准入供料，DSL 不重复创建物料。用户指定的 `Visual_Components_Box_00Mn` 为 Workpiece 模板，实际几何约 0.45 × 0.40 × 0.45 m，展开 M01–M04 四个独立物料；后续物料按准入创建。1 kg 为保留的仿真质量。原物料实例文件存入 legacy/pre-virtual-profile。

`linear_rail@1.1.0` 支持 move_to_location(target)、move_to_position(position_m) 和 stop_motion。`lift_table@1.2.0` 支持 accept_material、release_material、lift_to_location、lift_to_level、hold_lift，保留 transfer_material 兼容入口。允许路线在实例 transfer_routes 中声明。交接完成检查实际物料位置、接触支承、速度和库存事务；不要求未模拟的 Handler 回执。

两条滑轨的 `carriage_mount` 分别连接升降机的 `mount_base`，见 scene.json 的 connections。每组在 process.py 先调用 move_to_position 再调用 lift_to_level，两者均以米计。入、出料带的轨道对接坐标分别约 −0.017538 和 −2.013683，平台目标高度均为 0.54。第一列格位的轨道坐标约 −0.383069，四个基座相对高度依次为 0.84、1.44、2.04 和 2.64。改动装配或格位后须重新标定这些目标。接放料继续对照实测端点、支承和净空。

**正式四件任务的预期结果是第四件不可达。** 第四层板面约 2.80 m，箱体顶面会到 3.20 m，而升降机横梁下沿约 3.11 m。用户要求保留原任务，因此运行在第四件升降前报告 TARGET_UNREACHABLE，前三件保持入库状态、第四件保持低位平台承载，随后受控停止。没有改写 task-spec 或改存其他格位。

独立单件和前三件测试 fixture 已完整完成入出库；它们不替换正式四件目标。交接途中取消会保持夹持及资源并进入 attention_required；物理停止后可通过“放弃本次仿真并恢复初态”显式清理，不伪造交付成功。运行结果见 apps/docs/development-plans/011 开发记录与 evidence/011-s07-*.json。

历史 X1 机械臂、robot_arm 契约及旧 batch/bindings 移入 `legacy/pre-rail-model/`，不参与当前构建。旧模型路径只保留于历史资料。

重建：`python -B scripts/build-scene-catalog.py --scene S07`。重新导入场景后使用新包；已导入的旧包不会静默更新。

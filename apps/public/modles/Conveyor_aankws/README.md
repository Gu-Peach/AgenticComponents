# Conveyor_aankws 接触式输送建模

设备版本 0.4.1，采用 [设备契约](../../docs/设备契约.md) 1.1。保留 11 个参数、2 个纯空间端点、21 个设备级信号和 7 个行为。尚未接入物理或信号引擎。

| 模型 | 位置 | 当前状态 |
| --- | --- | --- |
| 两端吸附接口 | interfaces | 仅 snap；入口 (-0.749, 0.700, 0)，出口 (0.751, 0.700, 0)，单位 m，设备局部坐标 |
| 输送面 | type_specific_contract.conveying_surface | main_belt，局部 +X 流向、+Y 法向，整带驱动；碰撞体和摩擦待标定 |
| 工艺观测区域 | type_specific_contract.observation_regions | entry_zone、exit_zone、support_zone；有效体积与检测规则待标定 |

interfaces 不再保存 process、signal_refs 或信号绑定。signal_ports 声明设备信号；runtime_execution_contract.signal_management 规定未来引擎按 instance_id/port_id 注册、仲裁写入、交换快照，并通过实例 bindings 映射 PLC。

物料在输送机上的运动由未来引擎的 moving_surface_contact 接触模型求解，不采用两个端点之间的直线插值。输送面实际速度不等于物料实际速度；有效接触、摩擦、碰撞、重力和阻挡共同影响物料运动。渲染网格不需整体前移，载荷可在任意有效支承位置被带动，不要求先启动 transport_to_exit。

accept_material/release_material 是交接服务；transport_to_exit 跟踪物料的实际到达结果。服务不直接修改载荷位置。出口不允许放行时，控制器可按检测和制动距离受控停止整带；不能冻结单件物料或凭观测区产生隐形挡墙。物料离开和下游确认接收后才提交归属转移。

GLB 已检查：39 个节点、36 个 mesh，无骨骼和动画，Y-up。整机约 1.501 × 0.700 × 0.626 m（X/Y/Z），有效皮带约 1.400 × 0.500 m，顶面高约 0.700 m。上层皮带源节点 34，仅用于几何角色映射；渲染模型不是碰撞体标定结果，没有 UV 也不影响未来接触模型。

速度、容量和驱动动态仍是初始仿真配置。当前没有额外增加设备必填参数；静止/到速判据、接触摩擦和区域标定由后续引擎接入补齐，不从 GLB 外观虚构硬件能力。apps 可导入并校验声明；真实执行器、接触求解、信号引擎和区域检测均待实现。

入口吸附朝向为 -X，出口为 +X，up 均为 +Y。空间端点坐标不替代有效输送面、碰撞体和工艺检测区标定；两端间距 1.500 m 与有效上层皮带长度约 1.400 m 属于不同几何定义。

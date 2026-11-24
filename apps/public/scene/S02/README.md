# S02 三工位托盘装载

六个空托盘顺序通过三个工位。每盘先放 12 个下层件，再居中放 1 块盖板，最后在盖板上放 12 个上层件。累计 150 件物料。主线末段负责将满盘送至出口并交接。

| 绑定 | 真实 GLB 节点（按输送方向） |
| --- | --- |
| C1 → C2 → C3 → C4 → C5 | `__Geometry___00jc` → `Conveyor_#2_00gn` → `Conveyor_#3_00Xn` → `Conveyor_#4_00Hn` → `Conveyor_#13_00cn` |
| Pallet | `AssemblyBaseComponent_00mn`，含木结构及初始底板 `Block_Geo_00on` |
| F1、LowerPart、S1A → S1B、R1 | `__Geometry___00yc`、`Lathe_Comp_3_013n`、`Conveyor_#6_00fn` → `Conveyor_#7_00dn`、`RobotController_00qn` |
| F2、Cover、S2A → S2B、R2 | `__Geometry___003c`、`Block_Geo_004n`、`Conveyor_#9_00Zn` → `Conveyor_#8_00an`、`RobotController_#2_00Ln` |
| F3、UpperPart、S3A → S3B、R3 | `__Geometry___001c`、`Lathe_Comp_3_002n`、`Conveyor_#11_00Jn` → `Conveyor_#10_00Kn`、`RobotController_#3_005n` |

[工艺程序](process.py) 采用 ac-declarative/0.4。外层 repeat 遍历六盘，内层 select 按 lower、cover、upper 分别选取本盘待装物料。每个支线驱动组用 transport_to_position 运输指定物料并停稳，再用 pick_and_place 放到该盘的具名位置，move_to_pose 退位。五段主线共用一次托盘定位请求，C5 是请求所有者，station1–3 分别位于 C2、C3、C4。各供料口在环境声明中绑定对应物料模板和第一段支线入口。

[托盘定义](device/Pallet.json) 保存 25 个随盘移动的目标，其中下层与上层各按 4 列 × 3 行均布。设计取实测底板有效面（约 1.15 × 0.75 m）等分网格中心。下层件和上层件均高约 0.20 m，盖板厚约 0.01 m。放置点表示物料底面中心，已从场景坐标转换为托盘局部米制坐标。盖板在供料端长边沿世界 Z，装载时应与托盘长边对齐。具体抓放姿态与碰撞净空仍待验证。

生产声明使用 `count=6` 指定盘数，`per_carrier={'lower': 12, 'cover': 1, 'upper': 12}` 指定每盘各类物料的需求。编译器按托盘已声明的槽位顺序分配各类物料，核对容量、支承层和部分装载策略，生成独立主体 ID。初始库存为空。每种物料首件采用对应出料口的真实节点，其余按有限批次准入。同一份托盘几何展开为 P01–P06。[验收目标](task-spec.json) 使用项目既有 all_pallets_loaded_and_departed 和 pallets.items 清单。

三台机械臂各自绑定本场 GLB 的六级关节链和法兰。候选仿真沿用 S01 的物理轴线、无界关节假设和虚拟固定夹具，TCP 位于各自的法兰原点。物料从顶部中心抓取，以底面中心对准放置点。上下层件保持直立，盖板的目标姿态相对供料姿态绕场景 Y 轴旋转 90°。工位停靠点由主线过程节点投影到候选支承面，输送面采用厚 0.01 m 的支承代理。[节点测量记录](evidence/asset-bindings.json)

在 `apps` 下运行 `python -B scripts/build-scene-catalog.py --scene S02`，随后在工作台重新导入 S02，选中场景并打开 **PLC → 准备候选仿真**。准备阶段按空托盘装载清单创建物理会话，在工艺 tick 0 确认 `P01` 空载且受到主线支承，三路首件物料也均已获得支承。旧拆垛批次和旧物料实例位于 `legacy/unloading`。

新版 GLB 的关节局部坐标系与 S01 不同。底座绕竖直方向旋转，S01 用局部 +Y 表示，S02 用局部 +Z 表示。按当前 S02 实例定义，R1–R3 的六个局部正轴依次为 +Z、+Y、+Y、+Z、+Y、+Z。与 S01 比较同一物理姿态时，应将 J2、J3、J5 的角度取反。已用两场景的非零关节角和真实 GLB 节点核对法兰位置与朝向。

三个 home 位置通过 `reference=robot_rest_pose` 关联各自的 GLB 静止法兰。回位前核对零位关节角对应的 TCP 位置与朝向，再按关节速度和加速度限制返回这组关节角。抓取时，虚拟夹具沿物料顶面法向接近，法兰朝向顶面。这样下一周期从同一待机姿态取料。

真实 Jolt 试跑中，R1 于 tick 19643 完成首盘第十二件下层料的放置和回位。十二次抓取时的肘部高度均约 1.826 m，每次回位后的六轴角均为零。此次试跑覆盖 `P01.lower01` 至 `P01.lower12`，盖板转向和整盘交付仍待运行验证。

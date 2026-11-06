# S01：三盘各十二件双臂分类拆垛

本场景按用户核对的GLB节点补齐资产绑定。节点身份、静止矩阵和几何范围已提取；运动学、接触、制动和执行器仍未完成标定，不能据此直接运行。

## 真实资产对应

| 契约 | GLB原始节点 | 索引 | 职责 |
| --- | --- | ---: | --- |
| C1 | Conveyor(1) | 52 | 第一段主滚筒线 |
| C2 | Conveyor(2) | 103 | 第二段主滚筒线及候选分拣位 |
| C3 | Conveyor(3) | 138 | 近处机械臂的绿色出料线 |
| C4 | Conveyor(4) | 173 | 远处机械臂的绿色出料线 |
| R1 | robot(center)(1) | 485 | 远处机械臂，灰色A类→C4 |
| R2 | robot(2) | 375 | 近处机械臂，棕色B类→C3 |
| F1 | Feeder下的__Geometry__ [00Jc] | 186 | 出料口/供盘支承 |
| Pallet | AssemblyBaseComponent [00Ln] | 263 | 一盘十二件的托盘预制体 |
| Workpiece | Lathe Comp 3 [00On]等12个源节点 | 213等 | 统一物料预制体，灰/棕外观变体 |

精简device文件只保存必要的节点名、资源哈希和几何选择；编译器从GLB生成索引、原名/导入名、静止位姿和拥有的网格节点，完整路径与测量信息保留在evidence。`bound`只表示节点身份已核实，不表示机器人轴、TCP或物理行为已经验证。GLB没有拆分或改写。

托盘木结构为__Geometry__ [00Kc]（207），顶部垫板为__Geometry__ [00Lc]（209）。AssemblyBaseComponent父子树同时包含12件物料，托盘刚体只拥有木结构与垫板，排除12个物料子树。运行层需要在保留世界位姿的前提下分开物料可视与物理所有权。

## 物料节点与分工

| 槽位 | 节点索引 | 原始节点后缀 | GLB外观 | 分工 |
| --- | ---: | --- | --- | --- |
| slot1 | 213 | 00On | 灰 | R1→C4 |
| slot2 | 217 | 00Pn | 灰 | R1→C4 |
| slot3 | 221 | 00Qn | 棕 | R2→C3 |
| slot4 | 225 | 00Rn | 灰 | R1→C4 |
| slot5 | 229 | 00Sn | 灰 | R1→C4 |
| slot6 | 233 | 00Tn | 灰 | R1→C4 |
| slot7 | 237 | 00Un | 灰 | R1→C4 |
| slot8 | 241 | 00Vn | 棕 | R2→C3 |
| slot9 | 245 | 00Wn | 棕 | R2→C3 |
| slot10 | 249 | 00Xn | 棕 | R2→C3 |
| slot11 | 253 | 00Yn | 棕 | R2→C3 |
| slot12 | 257 | 00Zn | 棕 | R2→C3 |

灰/棕外观来自GLB材质chrome.002/copper.001，A/B工艺分配来自用户确认，不根据颜色自动推断未授权的工艺含义。

## 一份契约与有限批次

process.py使用`production(carrier_template="Pallet", count=3)`。只维护一份Pallet和一份Workpiece作者契约，预制体记录12个真实槽位、物料节点及类别。编译层派生P01—P03和M01_01—M03_12，共三盘36件；后两盘标为clone_on_admission，不假装已存在于原GLB。

目录中有9份精简设备/预制体实例声明，5类共享DeviceSpec位于contracts目录。运行身份展开后为46个对象：4条输送线、2台机械臂、1个出料口、3盘、36件。每个实例的信号路径单独展开，不复用Pallet/Workpiece模板的运行信号状态。

旧逻辑实例文件及batch/bindings移入legacy供追溯，当前运行入口只读取scene.json列出的device文件、process.py及task-spec.json。

## 几何与标定边界

- 两段主线的网格包围长度各约2.001 m，宽约0.926 m，最高约0.200 m；绿色出料线长约1.501 m、宽约0.323 m、最高约0.800 m。
- 托盘木结构加垫板的包围尺寸约1.200×0.150×0.800 m；不会把物料高度计入托盘高度。物料外包络直径约0.180 m、高约0.200 m，实际形状为阶梯空心件，碰撞体须另验证。
- 两机器人有可追溯的Axis 1—6链与法兰节点。未验证的关节轴与限位为空；用户已同意虚拟固定夹具，虚拟TCP采用法兰原点，作为明确的仿真配置，不能当成实际夹具测量。现有质量、速度、摩擦等实验配置均标明不是从GLB测得。
- 用户同意先以第二段中部作分拣候选位：载具根约为X=-0.3324、Y=0.1999、Z=-1.1967 m。该候选还须通过两臂FK/IK、碰撞、接触和制动验证；输送距离保留pending_calibration。
- 工艺采用每盘到位→两臂并行分拣→空盘移出。C1/C2属于耦合驱动组；par只是并行候选，真正同步接受、起停和故障联停还需协调适配器。
- Feeder的支承宽度约0.5 m，托盘宽约0.8 m；存在悬伸，需要支承与平衡验证。出料口的单物料生产接口不自动等于“载料托盘复制与供盘”已经实现。

证据在[evidence/s01-asset-binding.json](evidence/s01-asset-binding.json)、[evidence/glb-node-geometry.json](evidence/glb-node-geometry.json)及[evidence/production-expansion.json](evidence/production-expansion.json)。

重新执行`npm run catalog:scenes`更新构建包；已经导入工程的旧S01不会自动改写，需要从场景库重新导入以读取新定义。

文件分工与编辑说明见[精简设备格式](../../../docs/scene-devices.md)。参数来源证据见[evidence/parameter-provenance.json](evidence/parameter-provenance.json)。

## 场景配置与分拣点

scene.json只登记资源入口、场景坐标系、分拣点、初始载具、外部服务、主线驱动组及一份execution配置。旧的分工副本、双纵向工位说明、迁移备注和自然语言条件表已移除。分类与先后关系以process.py为准，数量由production及预制体派生，最终验收以task-spec.json为准。

sorting_station是分拣坐标的唯一来源，C2设备文件不再重复定义C2.work。其frame=scene_world_m表示GLB层级变换已合成后的场景米制坐标，Y向上；reference=carrier_origin表示移动到该点的是托盘原点。它不直接表示任何一件物料的抓取点，也不是机械臂TCP位置；实际抓取点由托盘位姿、槽位和物料几何求得。

当前候选坐标是[-0.3324265038139765, 0.19988948375233662, -1.1967109759622407] m，支承设备C2，服务机械臂R1/R2，一次容纳一盘。status=candidate保留待标定状态，编译产物包含该点并列出SORTING_STATION_CALIBRATION_REQUIRED，不会默认认定可达、无碰撞或已停稳。

外部供盘仍须核对入口容量、上一盘离开及机器人退位，空盘/物料移除仍须关联交接证据；主线耦合驱动仍须原子授权、同步起停和故障联停。这些是环境/行为适配器的执行义务，不靠scene中的自然语言字符串自动执行。现有DSL仍使用定距行为，待目标点输送适配接入后再替换其距离引用，候选坐标本身不会被当作已验证行程。

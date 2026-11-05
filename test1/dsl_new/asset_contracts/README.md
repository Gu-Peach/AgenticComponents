# 按项目规范定义的资产契约

八类标准资产采用DeviceSpec/1.1待接入模板，依据用户的[设备契约](../../docs/设备契约.md)、[信号与行为契约](../../docs/schema.md)和[参数契约](../../docs/参数契约.md)。加工设备独立标为待补规范的实验扩展。

| 文件别名 | 规范device_type | 定位 |
| --- | --- | --- |
| robot_arm | robot_arm | 机械臂动作、任务、接单控制和状态观测 |
| conveyor | conveyor | 连续输送、运输跟踪、交接、可选分区与反馈 |
| pallet | workpiece_carrier | 被动载具及可选槽位/装卸确认服务 |
| material | workpiece | 被动物料与外部物理/持有状态投影 |
| material_source | material_source_station | 生产与呈现物料的源端 |
| storage_rack | storage_rack | 静态货架及库位预留/存取服务 |
| lift_transport | lift_table | 升降及可选辅助横移，不暗含任意水平搬运 |
| rotary_table | rotary_table | 工位定位及可选台面输送 |
| processing_station | 实验扩展 | ExperimentalAssetContract，尚未纳入八类标准 |

机器入口为[catalog.json](catalog.json)，定义位于assets/。详细差异、字段职责和DSL绑定影响见[规范对照与迁移](docs/规范对照与迁移.md)，完整行为清单见[资产行为目录](docs/资产行为目录.md)。

```powershell
python -B tools/validate_contracts.py
python -B -m unittest discover -s tests -p "test_*.py"
node tools/check_app_import.cjs
```

Python检查需要jsonschema 4.x；应用导入检查复用项目apps/node_modules及现有normalizeUnifiedDevice。当前八类都标为pending_adapter，观测提供者pending_provider，几何未标定。通过声明检查不等于具备实际执行能力。

请修改DeviceSpec规范字段，不再维护旧asset-contract/0.1的第二套行为、信号和条件。新增设备能力必须先明确规范依据、参数/载荷、信号及完成语义；不得通过DSL的“候选能力表”绕过设备契约。

## 现成模型档案

[三个现成案例复核](docs/现成模型案例复核.md)核对robot_UR10、Conveyor_aankws和engine_block的真实源定义、载荷接口及支持范围。[model-profiles.json](model-profiles.json)只引用源文件并锁定哈希，不替代源定义、不自动把实现状态或默认值继承到通用模板。规范允许按能力裁剪参数、信号和行为；完整模板不是所有实例的必填清单。

传送带定义1.1.0包含可选的move_by_distance有限任务及target_distance输入，规范来源为docs/schema.md。仅声明待实现能力；模型档案未因此继承定距执行能力。
